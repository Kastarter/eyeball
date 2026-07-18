"""Durable session lifecycle, fake parity runtime, and graceful drain."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, cast
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import JsonValue

from .contracts import (
    ChatTurnRequest,
    ChatTurnResponse,
    EventPage,
    FakeTransport,
    PublicSession,
    SessionEvent,
    StartSessionRequest,
)
from .executor import ExecutorClient, ExecutorProtocolError, ExecutorResult
from .repository import (
    PendingToolCall,
    SessionNotFoundError,
    StateConflictError,
    VoiceSessionRepository,
)

TERMINAL_STATES = {"completed", "failed", "abandoned"}
ChatResponder = Callable[
    [str, StartSessionRequest, str, list[SessionEvent]], Awaitable[str]
]


class WorkerDrainingError(RuntimeError):
    pass


class InvalidTransportError(RuntimeError):
    pass


class SessionPolicyError(RuntimeError):
    pass


@dataclass(slots=True)
class ManagedSession:
    subscribers: set[asyncio.Queue[SessionEvent]] = field(default_factory=set)
    task: asyncio.Task[None] | None = None
    stop_requested: asyncio.Event = field(default_factory=asyncio.Event)
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    tool_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionManager:
    def __init__(
        self,
        executor: ExecutorClient,
        repository: VoiceSessionRepository,
    ) -> None:
        self._executor = executor
        self._repository = repository
        self._sessions: dict[str, ManagedSession] = {}
        self._lock = asyncio.Lock()
        self._accepting = True
        self._chat_responder: ChatResponder | None = None

    @property
    def accepting(self) -> bool:
        return self._accepting

    @property
    def active_count(self) -> int:
        return self._repository.active_count()

    async def recover(self) -> None:
        """Recover fake/chat state and fail live sessions that lost their socket."""
        for stored in self._repository.active():
            managed = self._sessions.setdefault(stored.session.id, ManagedSession())
            if stored.pending_tool is not None:
                await self._dispatch_pending(stored.session.id, stored.pending_tool)
                stored = self._repository.get(stored.session.id)
            if isinstance(stored.request.transport, FakeTransport):
                managed.task = asyncio.create_task(
                    self._run_fake(stored.session.id),
                    name=f"voice-fake-{stored.session.id}",
                )
            elif stored.request.transport.kind == "chat":
                continue
            else:
                self._fail(
                    stored.session.id,
                    "The worker restarted before the live media session completed.",
                )

    def set_chat_responder(self, responder: ChatResponder) -> None:
        self._chat_responder = responder

    async def start(self, request: StartSessionRequest) -> PublicSession:
        self._validate_request(request)
        async with self._lock:
            if not self._accepting:
                raise WorkerDrainingError("The voice worker is draining.")
            session_id = f"session_{uuid4().hex}"
            transport = cast(
                Literal["pstn:twilio", "webrtc:livekit", "chat"],
                {
                    "twilio": "pstn:twilio",
                    "livekit": "webrtc:livekit",
                    "chat": "chat",
                    "fake": "chat",
                }[request.transport.kind],
            )
            session = PublicSession(
                id=session_id,
                project_id=request.scope.project_id,
                user_id=request.scope.user_id,
                agent_id=request.agent.id,
                agent_revision=request.agent.revision,
                transport=transport,
                state="created",
                created_at=_now(),
                last_event_sequence=0,
            )
            stored = self._repository.create(request, session)
            managed = ManagedSession()
            self._sessions[session_id] = managed
            if isinstance(request.transport, FakeTransport):
                managed.task = asyncio.create_task(
                    self._run_fake(session_id), name=f"voice-fake-{session_id}"
                )
            return stored.session

    async def start_runtime(
        self, session_id: str, runtime: Callable[[], Awaitable[None]]
    ) -> None:
        managed = self._managed(session_id)
        if managed.task is not None:
            raise InvalidTransportError("The session runtime has already started.")
        managed.task = asyncio.create_task(
            self._run_media(session_id, runtime), name=f"voice-media-{session_id}"
        )

    async def wait_runtime(self, session_id: str) -> None:
        task = self._managed(session_id).task
        if task is not None:
            await task

    def mark_connecting(self, session_id: str) -> PublicSession:
        stored = self._repository.get(session_id)
        if stored.session.state == "created":
            return self._transition(session_id, "connecting")
        return stored.session

    def get(self, session_id: str) -> PublicSession:
        return self._repository.get(session_id).session

    def request(self, session_id: str) -> StartSessionRequest:
        return self._repository.get(session_id).request

    def page(self, session_id: str, after_sequence: int, limit: int) -> EventPage:
        return self._repository.page(session_id, after_sequence, limit)

    async def stop(self, session_id: str) -> PublicSession:
        managed = self._managed(session_id)
        managed.stop_requested.set()
        if managed.task is not None and not managed.task.done():
            managed.task.cancel()
            await asyncio.gather(managed.task, return_exceptions=True)
        state = self.get(session_id).state
        if state in TERMINAL_STATES:
            return self.get(session_id)
        if state in {"created", "connecting"}:
            return self._transition(session_id, "abandoned")
        if state == "in-progress":
            self._transition(session_id, "wrap-up")
        return self._transition(session_id, "completed")

    def fail(self, session_id: str, message: str) -> None:
        self._fail(session_id, message)

    async def chat_turn(
        self, session_id: str, request: ChatTurnRequest
    ) -> ChatTurnResponse:
        async with self._managed(session_id).turn_lock:
            return await self._chat_turn(session_id, request)

    async def _chat_turn(
        self, session_id: str, request: ChatTurnRequest
    ) -> ChatTurnResponse:
        stored = self._repository.get(session_id)
        if stored.request.transport.kind != "chat":
            raise InvalidTransportError("Only chat sessions accept HTTP turns.")
        request_json = request.model_dump_json(by_alias=True, exclude_none=True)
        replay = self._repository.chat_receipt(
            session_id, request.idempotency_key, request_json
        )
        if replay is not None:
            return replay
        if stored.session.state == "created":
            self._transition(session_id, "in-progress")
        elif stored.session.state != "in-progress":
            raise StateConflictError("The chat session is not active.")
        human_key = f"chat:{request.idempotency_key}:human"
        agent_key = f"chat:{request.idempotency_key}:agent"
        turn_digest = hashlib.sha256(request.idempotency_key.encode()).hexdigest()[:16]
        turn_id = f"turn_{session_id}_{turn_digest}"
        human_event = self._repository.event(session_id, human_key)
        if human_event is None:
            turn_number = self._repository.increment_turn(session_id)
            self._transcript(
                session_id,
                event_key=human_key,
                turn_id=turn_id,
                speaker="human",
                text=request.text,
                turn_number=turn_number,
            )
        else:
            if (
                human_event.data.get("turnId") != turn_id
                or human_event.data.get("text") != request.text
            ):
                raise StateConflictError(
                    "The chat idempotency key was reused with different input."
                )
            start_ms = human_event.data.get("startMs")
            turn_number = (
                int(start_ms) // 1_000 + 1
                if isinstance(start_ms, int) and not isinstance(start_ms, bool)
                else max(1, stored.next_turn)
            )
        agent_event = self._repository.event(session_id, agent_key)
        if agent_event is None:
            if self._chat_responder is None:
                raise InvalidTransportError(
                    "The configured worker has no chat model responder."
                )
            assistant = await self._chat_responder(
                session_id,
                stored.request,
                turn_id,
                self._all_events(session_id),
            )
            if assistant.strip() == "":
                raise InvalidTransportError(
                    "The chat model returned an empty assistant turn."
                )
            self._transcript(
                session_id,
                event_key=agent_key,
                turn_id=turn_id,
                speaker="agent",
                text=assistant,
                turn_number=turn_number,
            )
        else:
            assistant_value = agent_event.data.get("text")
            if not isinstance(assistant_value, str):
                raise StateConflictError(
                    "The durable chat response is missing assistant text."
                )
            assistant = assistant_value
        response = ChatTurnResponse(
            session=self.get(session_id),
            turn_id=turn_id,
            assistant_message=assistant,
        )
        self._repository.remember_chat_receipt(
            session_id,
            request.idempotency_key,
            request_json,
            response,
        )
        return response

    def _all_events(self, session_id: str) -> list[SessionEvent]:
        events: list[SessionEvent] = []
        cursor = 0
        while True:
            page = self._repository.page(session_id, cursor, 200)
            events.extend(page.events)
            cursor = page.next_sequence
            if not page.has_more:
                return events

    async def subscribe(
        self, session_id: str, after_sequence: int
    ) -> asyncio.Queue[SessionEvent]:
        managed = self._managed(session_id)
        queue: asyncio.Queue[SessionEvent] = asyncio.Queue()
        cursor = after_sequence
        while True:
            page = self._repository.page(session_id, cursor, 200)
            for event in page.events:
                queue.put_nowait(event)
            cursor = page.next_sequence
            if not page.has_more:
                break
        managed.subscribers.add(queue)
        return queue

    def unsubscribe(self, session_id: str, queue: asyncio.Queue[SessionEvent]) -> None:
        managed = self._sessions.get(session_id)
        if managed is not None:
            managed.subscribers.discard(queue)

    async def drain(self, drain_timeout: float) -> None:
        self._accepting = False
        tasks = [
            managed.task
            for managed in self._sessions.values()
            if managed.task is not None and not managed.task.done()
        ]
        if not tasks:
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True),
                timeout=drain_timeout,
            )
        except TimeoutError:
            for session_id, managed in self._sessions.items():
                if managed.task is not None and not managed.task.done():
                    managed.stop_requested.set()
                    managed.task.cancel()
                state = self.get(session_id).state
                if state not in TERMINAL_STATES:
                    self._transition(session_id, "abandoned")
            await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self) -> None:
        await self._executor.close()
        self._repository.close()

    async def execute_tool_for_session(
        self,
        session_id: str,
        turn_id: str,
        tool: str,
        input: dict[str, JsonValue],
    ) -> ExecutorResult:
        async with self._managed(session_id).tool_lock:
            event_key = f"media:{turn_id}:{tool}"
            return await self._execute_tool(
                session_id,
                event_key=event_key,
                turn_id=turn_id,
                tool=tool,
                input=input,
            )

    def record_transcript(self, session_id: str, speaker: str, text: str) -> str:
        if speaker not in {"human", "agent"}:
            raise ValueError("Transcript speaker must be human or agent.")
        turn_number = self._repository.increment_turn(session_id)
        turn_id = f"turn_{session_id}_{turn_number:04d}"
        self._transcript(
            session_id,
            event_key=f"media:{turn_number}:{speaker}",
            turn_id=turn_id,
            speaker=speaker,
            text=text,
            turn_number=turn_number,
        )
        return turn_id

    async def _run_fake(self, session_id: str) -> None:
        try:
            state = self.get(session_id).state
            if state == "created":
                self._transition(session_id, "connecting")
                self._transition(session_id, "in-progress")
            stored = self._repository.get(session_id)
            if stored.pending_tool is not None:
                await self._dispatch_pending(session_id, stored.pending_tool)
            transport = cast(FakeTransport, stored.request.transport)
            max_duration = _max_duration(stored.request)
            async with asyncio.timeout(max_duration):
                for index in range(stored.runtime_cursor, len(transport.turns)):
                    if self._managed(session_id).stop_requested.is_set():
                        return
                    turn = transport.turns[index]
                    if turn.delay_ms > 0:
                        await asyncio.sleep(turn.delay_ms / 1000)
                    turn_number = index + 1
                    turn_id = f"turn_{session_id}_{turn_number:04d}"
                    self._transcript(
                        session_id,
                        event_key=f"fake:{index}:human",
                        turn_id=turn_id,
                        speaker="human",
                        text=turn.caller,
                        turn_number=turn_number,
                    )
                    assistant = turn.assistant or "I will help with that."
                    self._transcript(
                        session_id,
                        event_key=f"fake:{index}:agent",
                        turn_id=turn_id,
                        speaker="agent",
                        text=assistant,
                        turn_number=turn_number,
                    )
                    if turn.tool_call is not None:
                        await self._execute_tool(
                            session_id,
                            event_key=f"fake:{index}:tool",
                            turn_id=turn_id,
                            tool=turn.tool_call.name,
                            input=turn.tool_call.input,
                            runtime_cursor=index + 1,
                        )
                    self._repository.set_runtime_cursor(session_id, index + 1)
            if self.get(session_id).state == "in-progress":
                self._transition(session_id, "wrap-up")
                self._transition(session_id, "completed")
        except TimeoutError:
            self._fail(
                session_id,
                "The session exceeded maxDurationSeconds.",
                code="timeout",
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail(session_id, "The deterministic session runtime failed.")

    async def _run_media(
        self, session_id: str, runtime: Callable[[], Awaitable[None]]
    ) -> None:
        try:
            if self.get(session_id).state == "created":
                self._transition(session_id, "connecting")
            self._transition(session_id, "in-progress")
            async with asyncio.timeout(_max_duration(self.request(session_id))):
                await runtime()
            if self.get(session_id).state == "in-progress":
                self._transition(session_id, "wrap-up")
                self._transition(session_id, "completed")
        except TimeoutError:
            self._fail(
                session_id,
                "The session exceeded maxDurationSeconds.",
                code="timeout",
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail(session_id, "The provider-backed session runtime failed.")

    async def _execute_tool(
        self,
        session_id: str,
        *,
        event_key: str,
        turn_id: str,
        tool: str,
        input: dict[str, JsonValue],
        runtime_cursor: int | None = None,
    ) -> ExecutorResult:
        stored = self._repository.get(session_id)
        execution_id = _execution_id(session_id, event_key)
        pending, call_event = self._repository.create_tool_call(
            session_id,
            event_key=f"{event_key}:call",
            turn_id=turn_id,
            execution_id=execution_id,
            tool=tool,
            input=input,
            runtime_cursor=runtime_cursor,
        )
        self._publish(session_id, call_event)
        allowed = {item.name for item in stored.request.agent.allowed_tools}
        if tool not in allowed:
            result = ExecutorResult(
                execution_id=execution_id,
                tool=tool,
                error={
                    "code": "not_supported",
                    "message": "The tool is not allowed by the pinned agent revision.",
                    "retryable": False,
                },
            )
        else:
            result = await self._call_executor(session_id, pending)
        result_data: dict[str, JsonValue]
        if result.error is not None:
            result_data = {"error": result.error}
        else:
            result_data = {"output": result.output}
        result_event = self._repository.complete_tool_call(
            session_id,
            execution_id=execution_id,
            result=result_data,
        )
        self._publish(session_id, result_event)
        return result

    async def _dispatch_pending(
        self, session_id: str, pending: PendingToolCall
    ) -> ExecutorResult:
        stored = self._repository.get(session_id)
        allowed = {item.name for item in stored.request.agent.allowed_tools}
        if pending.tool not in allowed:
            result = ExecutorResult(
                execution_id=pending.execution_id,
                tool=pending.tool,
                error={
                    "code": "not_supported",
                    "message": "The tool is not allowed by the pinned agent revision.",
                    "retryable": False,
                },
            )
        else:
            result = await self._call_executor(session_id, pending)
        result_data: dict[str, JsonValue]
        if result.error is not None:
            result_data = {"error": result.error}
        else:
            result_data = {"output": result.output}
        event = self._repository.complete_tool_call(
            session_id,
            execution_id=pending.execution_id,
            result=result_data,
        )
        self._publish(session_id, event)
        return result

    async def _call_executor(
        self, session_id: str, pending: PendingToolCall
    ) -> ExecutorResult:
        stored = self._repository.get(session_id)
        try:
            return await self._executor.execute(
                session_id=session_id,
                event_sequence=pending.event_sequence,
                execution_id=pending.execution_id,
                user_id=stored.request.scope.user_id,
                tool=pending.tool,
                input=pending.input,
            )
        except ExecutorProtocolError as error:
            return ExecutorResult(
                execution_id=pending.execution_id,
                tool=pending.tool,
                error={
                    "code": "provider_unavailable",
                    "message": str(error),
                    "retryable": True,
                },
            )

    def _transcript(
        self,
        session_id: str,
        *,
        event_key: str,
        turn_id: str,
        speaker: str,
        text: str,
        turn_number: int,
    ) -> SessionEvent:
        start_ms = max(0, (turn_number - 1) * 1_000)
        return self._emit(
            session_id,
            event_key,
            {
                "type": "turn.transcript",
                "turnId": turn_id,
                "speaker": speaker,
                "text": text,
                "final": True,
                "startMs": start_ms,
                "endMs": start_ms + max(250, len(text) * 20),
            },
        )

    def _transition(self, session_id: str, target: str) -> PublicSession:
        before = self.get(session_id)
        session = self._repository.transition(session_id, target)
        self._publish_new_events(session_id, before.last_event_sequence)
        return session

    def _fail(
        self, session_id: str, message: str, *, code: str = "provider_error"
    ) -> None:
        session = self.get(session_id)
        if session.state in TERMINAL_STATES:
            return
        before = session.last_event_sequence
        self._repository.transition(
            session_id,
            "failed",
            error={"code": code, "message": message, "retryable": False},
        )
        self._publish_new_events(session_id, before)

    def _emit(
        self, session_id: str, event_key: str, data: dict[str, JsonValue]
    ) -> SessionEvent:
        event = self._repository.append_event(session_id, event_key, data)
        self._publish(session_id, event)
        return event

    def _publish_new_events(self, session_id: str, after_sequence: int) -> None:
        page = self._repository.page(session_id, after_sequence, 200)
        for event in page.events:
            self._publish(session_id, event)

    def _publish(self, session_id: str, event: SessionEvent) -> None:
        managed = self._sessions.get(session_id)
        if managed is None:
            return
        for queue in managed.subscribers:
            queue.put_nowait(event.model_copy(deep=True))

    def _managed(self, session_id: str) -> ManagedSession:
        managed = self._sessions.get(session_id)
        if managed is not None:
            return managed
        self._repository.get(session_id)
        managed = ManagedSession()
        self._sessions[session_id] = managed
        return managed

    @staticmethod
    def _validate_request(request: StartSessionRequest) -> None:
        names = [tool.name for tool in request.agent.allowed_tools]
        if len(names) != len(set(names)):
            raise SessionPolicyError("Agent allowedTools must not contain duplicates.")
        if request.transport.kind != "fake":
            mode = request.agent.recording_policy.get("mode", "disabled")
            if mode != "disabled":
                raise SessionPolicyError(
                    "This worker build requires recordingPolicy.mode=disabled "
                    "for live sessions."
                )
        _enforce_allowed_hours(request)


def _max_duration(request: StartSessionRequest) -> float:
    value = request.agent.guardrails.get("maxDurationSeconds", 300)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise SessionPolicyError("guardrails.maxDurationSeconds must be positive.")
    return float(value)


def _enforce_allowed_hours(request: StartSessionRequest) -> None:
    windows = request.agent.guardrails.get("allowedHours")
    if windows is None:
        return
    if not isinstance(windows, list) or not windows:
        raise SessionPolicyError("guardrails.allowedHours must be a non-empty array.")
    weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    for value in windows:
        if not isinstance(value, dict):
            continue
        zone_name = value.get("timeZone")
        if not isinstance(zone_name, str):
            continue
        try:
            local = datetime.now(tz=ZoneInfo(zone_name))
        except ZoneInfoNotFoundError as error:
            raise SessionPolicyError(
                f"Unknown allowed-hours time zone: {zone_name}."
            ) from error
        days = value.get("days")
        start = value.get("start")
        end = value.get("end")
        if not (
            isinstance(days, list) and isinstance(start, str) and isinstance(end, str)
        ):
            continue
        current_time = local.strftime("%H:%M")
        current_day = weekdays[local.weekday()]
        if start < end and current_day in days and start <= current_time < end:
            return
        if start > end:
            previous_day = weekdays[(local.weekday() - 1) % len(weekdays)]
            if (current_day in days and current_time >= start) or (
                previous_day in days and current_time < end
            ):
                return
    raise SessionPolicyError("The session is outside the agent's allowed hours.")


def _execution_id(session_id: str, event_key: str) -> str:
    digest = hashlib.sha256(f"{session_id}\0{event_key}".encode()).hexdigest()[:32]
    return f"exe_voice_{digest}"


def _now() -> str:
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


__all__ = [
    "InvalidTransportError",
    "SessionManager",
    "SessionNotFoundError",
    "SessionPolicyError",
    "StateConflictError",
    "WorkerDrainingError",
]
