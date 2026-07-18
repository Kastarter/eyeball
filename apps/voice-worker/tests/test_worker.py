from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar, cast
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from eyeball_voice_worker.app import create_app
from eyeball_voice_worker.config import WorkerConfig
from eyeball_voice_worker.contracts import (
    WIRE_VERSION,
    WIRE_VERSION_HEADER,
    ChatTurnRequest,
    PublicSession,
    StartSessionRequest,
    TwilioTransport,
)
from eyeball_voice_worker.executor import ExecutorClient, ExecutorResult
from eyeball_voice_worker.manager import SessionManager
from eyeball_voice_worker.media import (
    PipecatPipelineFactory,
    TwilioDialer,
    twilio_media_token,
)
from eyeball_voice_worker.repository import StateConflictError, VoiceSessionRepository

CONTROL_TOKEN = "worker-control-test-token-at-least-32-bytes"
WORKER_KEY = "ey_test_worker_user_pinned"


def start_payload(*, delay_ms: int = 0, with_tool: bool = True) -> dict[str, Any]:
    turn: dict[str, Any] = {
        "caller": "Please send the confirmation.",
        "assistant": "I will send it now.",
        "delayMs": delay_ms,
    }
    allowed_tools: list[dict[str, Any]] = []
    if with_tool:
        turn["toolCall"] = {
            "name": "gmail.send_email",
            "input": {
                "to": ["sam@example.com"],
                "subject": "Confirmed",
                "body": "Your table is confirmed.",
            },
        }
        allowed_tools.append(
            {
                "name": "gmail.send_email",
                "description": "Send a confirmation email.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["to", "subject", "body"],
                    "properties": {
                        "to": {"type": "array", "items": {"type": "string"}},
                        "subject": {"type": "string"},
                        "body": {"type": "string"},
                    },
                },
            }
        )
    return {
        "contractVersion": WIRE_VERSION,
        "scope": {"projectId": "proj_worker", "userId": "user_worker"},
        "agent": {
            "id": "va_worker",
            "revision": 3,
            "systemPrompt": "Send only confirmed reservation details.",
            "llm": {"provider": "anthropic", "model": "claude-sonnet-4-6"},
            "voice": {
                "stt": {"provider": "deepgram", "model": "nova-3"},
                "tts": {"provider": "elevenlabs", "voiceId": "voice_test"},
            },
            "allowedTools": allowed_tools,
            "guardrails": {
                "maxDurationSeconds": 30,
                "handoffToHuman": {"enabled": False},
            },
            "webhooks": {
                "endpointIds": [],
                "transcript": True,
                "events": [
                    "session.lifecycle",
                    "turn.transcript",
                    "tool_call",
                    "tool_result",
                ],
            },
            "recordingPolicy": {
                "mode": "disabled",
                "consent": "external",
                "retentionDays": 0,
                "redactDtmf": True,
            },
            "bargeIn": {"enabled": True},
        },
        "transport": {"kind": "fake", "turns": [turn]},
    }


def worker_config(path: Path) -> WorkerConfig:
    return WorkerConfig(
        database_path=path,
        media_mode="fake",
        executor_url="https://executor.test",
        executor_key=WORKER_KEY,
        control_token=CONTROL_TOKEN,
        allow_fake_transport=True,
        drain_timeout_seconds=0.05,
    )


def control_headers() -> dict[str, str]:
    return {
        WIRE_VERSION_HEADER: WIRE_VERSION,
        "Authorization": f"Bearer {CONTROL_TOKEN}",
    }


def test_config_normalizes_blank_optional_compose_values() -> None:
    config = WorkerConfig.from_env(
        {
            "EYEBALL_VOICE_DATABASE_PATH": ":memory:",
            "EYEBALL_VOICE_MEDIA_MODE": "pipecat",
            "EYEBALL_VOICE_WORKER_TOKEN": CONTROL_TOKEN,
            "EYEBALL_VOICE_PUBLIC_URL": "  ",
            "ANTHROPIC_API_KEY": "",
            "LIVEKIT_URL": "",
        }
    )

    assert config.public_url is None
    assert config.anthropic_api_key is None
    assert config.livekit_url is None
    with pytest.raises(ValueError, match="at least 32 bytes"):
        WorkerConfig.from_env(
            {
                "EYEBALL_VOICE_DATABASE_PATH": ":memory:",
                "EYEBALL_VOICE_MEDIA_MODE": "pipecat",
                "EYEBALL_VOICE_WORKER_TOKEN": "too-short",
            }
        )


def test_start_contract_rejects_noncanonical_fake_tool_names() -> None:
    payload = start_payload()
    payload["transport"]["turns"][0]["toolCall"]["name"] = "gmail__send_email"

    with pytest.raises(ValueError, match="string_pattern_mismatch"):
        StartSessionRequest.model_validate(payload)


async def wait_for_terminal(
    client: httpx.AsyncClient, session_id: str
) -> dict[str, Any]:
    for _ in range(100):
        response = await client.get(
            f"/v1/sessions/{session_id}", headers=control_headers()
        )
        body = cast(dict[str, Any], response.json())
        if body["session"]["state"] in {"completed", "failed", "abandoned"}:
            return body
        await asyncio.sleep(0.005)
    raise AssertionError("voice session did not become terminal")


@pytest.mark.asyncio
async def test_fake_transport_reenters_executor_with_durable_identity(
    tmp_path: Path,
) -> None:
    calls: list[httpx.Request] = []

    def execute(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        body = json.loads(request.content)
        execution_id = request.headers["X-Eyeball-Execution-Id"]
        return httpx.Response(
            200,
            json={
                "executionId": execution_id,
                "tool": body["tool"],
                "status": "succeeded",
                "output": {"messageId": "message_worker_test"},
            },
        )

    executor_http = httpx.AsyncClient(transport=httpx.MockTransport(execute))
    database = tmp_path / "voice.sqlite3"
    app = create_app(config=worker_config(database), executor_http_client=executor_http)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://worker.test"
        ) as client:
            created = await client.post(
                "/v1/sessions", headers=control_headers(), json=start_payload()
            )
            assert created.status_code == 201
            session_id = created.json()["session"]["id"]
            terminal = await wait_for_terminal(client, session_id)
            assert terminal["session"]["state"] == "completed"

            event_response = await client.get(
                f"/v1/sessions/{session_id}/events?afterSequence=0&limit=200",
                headers=control_headers(),
            )
            page = event_response.json()
            events = page["events"]
            assert [event["sequence"] for event in events] == list(
                range(1, len(events) + 1)
            )
            tool_call = next(
                event for event in events if event["data"]["type"] == "tool_call"
            )
            tool_result = next(
                event for event in events if event["data"]["type"] == "tool_result"
            )
            assert (
                tool_result["data"]["executionId"] == tool_call["data"]["executionId"]
            )
            assert tool_result["data"]["output"] == {"messageId": "message_worker_test"}

    assert len(calls) == 1
    call = calls[0]
    assert call.headers["Authorization"] == f"Bearer {WORKER_KEY}"
    assert call.headers["X-Eyeball-Execution-Id"] == tool_call["data"]["executionId"]
    assert call.headers["Idempotency-Key"] == (
        f"voice-session:{session_id}:event:{tool_call['sequence']}"
    )

    # Terminal state and ordered history survive a new worker process.
    restarted = create_app(config=worker_config(database))
    async with restarted.router.lifespan_context(restarted):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted),
            base_url="http://worker.test",
        ) as client:
            response = await client.get(
                f"/v1/sessions/{session_id}", headers=control_headers()
            )
            assert response.json()["session"]["state"] == "completed"
            replay = await client.get(
                f"/v1/sessions/{session_id}/events?afterSequence=0&limit=200",
                headers=control_headers(),
            )
            assert replay.json()["events"] == events
    await executor_http.aclose()


@pytest.mark.asyncio
async def test_recovery_reuses_pending_execution_id(tmp_path: Path) -> None:
    database = tmp_path / "recovery.sqlite3"
    request = StartSessionRequest.model_validate(start_payload())
    session = PublicSession(
        id="session_recovery",
        project_id=request.scope.project_id,
        user_id=request.scope.user_id,
        agent_id=request.agent.id,
        agent_revision=request.agent.revision,
        transport="chat",
        state="created",
        created_at="2026-07-18T00:00:00Z",
        last_event_sequence=0,
    )
    repository = VoiceSessionRepository(database)
    repository.create(request, session)
    repository.transition(session.id, "connecting")
    repository.transition(session.id, "in-progress")
    pending, call_event = repository.create_tool_call(
        session.id,
        event_key="fake:0:tool:call",
        turn_id="turn_session_recovery_0001",
        execution_id="exe_voice_recovery",
        tool="gmail.send_email",
        input={"to": ["sam@example.com"], "subject": "Confirmed", "body": "Done"},
        runtime_cursor=1,
    )
    repository.close()

    calls: list[httpx.Request] = []

    def execute(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "executionId": request.headers["X-Eyeball-Execution-Id"],
                "tool": body["tool"],
                "status": "succeeded",
                "output": {"replayed": True},
            },
        )

    executor_http = httpx.AsyncClient(transport=httpx.MockTransport(execute))
    recovered_repository = VoiceSessionRepository(database)
    manager = SessionManager(
        ExecutorClient(
            base_url="https://executor.test",
            api_key=WORKER_KEY,
            client=executor_http,
        ),
        recovered_repository,
    )
    await manager.recover()
    for _ in range(100):
        if manager.get(session.id).state == "completed":
            break
        await asyncio.sleep(0.005)
    assert manager.get(session.id).state == "completed"
    assert len(calls) == 1
    assert calls[0].headers["X-Eyeball-Execution-Id"] == pending.execution_id
    assert calls[0].headers["Idempotency-Key"] == (
        f"voice-session:{session.id}:event:{call_event.sequence}"
    )
    page = manager.page(session.id, 0, 200)
    result = next(event for event in page.events if event.data["type"] == "tool_result")
    assert result.data["executionId"] == pending.execution_id
    await manager.drain(0.1)
    await manager.close()
    await executor_http.aclose()


@pytest.mark.asyncio
async def test_recovery_never_dispatches_a_tool_outside_the_snapshot(
    tmp_path: Path,
) -> None:
    database = tmp_path / "disallowed.sqlite3"
    payload = start_payload(with_tool=False)
    request = StartSessionRequest.model_validate(payload)
    session = PublicSession(
        id="session_disallowed",
        project_id=request.scope.project_id,
        user_id=request.scope.user_id,
        agent_id=request.agent.id,
        agent_revision=request.agent.revision,
        transport="chat",
        state="created",
        created_at="2026-07-18T00:00:00Z",
        last_event_sequence=0,
    )
    repository = VoiceSessionRepository(database)
    repository.create(request, session)
    repository.transition(session.id, "in-progress")
    repository.create_tool_call(
        session.id,
        event_key="fake:0:tool:call",
        turn_id="turn_session_disallowed_0001",
        execution_id="exe_voice_disallowed",
        tool="gmail.send_email",
        input={"to": ["sam@example.com"]},
        runtime_cursor=1,
    )
    repository.close()

    calls: list[httpx.Request] = []

    def execute(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(500)

    executor_http = httpx.AsyncClient(transport=httpx.MockTransport(execute))
    recovered_repository = VoiceSessionRepository(database)
    manager = SessionManager(
        ExecutorClient(
            base_url="https://executor.test",
            api_key=WORKER_KEY,
            client=executor_http,
        ),
        recovered_repository,
    )
    await manager.recover()
    for _ in range(100):
        if manager.get(session.id).state == "completed":
            break
        await asyncio.sleep(0.005)

    assert calls == []
    result = next(
        event
        for event in manager.page(session.id, 0, 200).events
        if event.data["type"] == "tool_result"
    )
    assert result.data["error"] == {
        "code": "not_supported",
        "message": "The tool is not allowed by the pinned agent revision.",
        "retryable": False,
    }
    await manager.drain(0.1)
    await manager.close()
    await executor_http.aclose()


@pytest.mark.asyncio
async def test_chat_turn_serializes_and_replays_one_model_response(
    tmp_path: Path,
) -> None:
    payload = start_payload(with_tool=False)
    payload["transport"] = {"kind": "chat"}
    request = StartSessionRequest.model_validate(payload)
    repository = VoiceSessionRepository(tmp_path / "chat.sqlite3")
    executor_http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: httpx.Response(500))
    )
    manager = SessionManager(
        ExecutorClient(
            base_url="https://executor.test",
            api_key=WORKER_KEY,
            client=executor_http,
        ),
        repository,
    )
    responses: list[str] = []

    async def respond(
        _session_id: str,
        _request: StartSessionRequest,
        _turn_id: str,
        history: list[Any],
    ) -> str:
        responses.append(history[-1].data["text"])
        await asyncio.sleep(0)
        return "Your reservation is confirmed."

    manager.set_chat_responder(respond)
    session = await manager.start(request)
    turn = ChatTurnRequest(
        contract_version=WIRE_VERSION,
        text="Please confirm my reservation.",
        idempotency_key="message_chat_1",
    )

    first, replay = await asyncio.gather(
        manager.chat_turn(session.id, turn),
        manager.chat_turn(session.id, turn),
    )

    assert first == replay
    assert responses == ["Please confirm my reservation."]
    transcripts = [
        event
        for event in manager.page(session.id, 0, 200).events
        if event.data["type"] == "turn.transcript"
    ]
    assert [event.data["speaker"] for event in transcripts] == ["human", "agent"]
    with pytest.raises(StateConflictError):
        await manager.chat_turn(
            session.id,
            turn.model_copy(update={"text": "Different text."}),
        )
    await manager.drain(0.1)
    await manager.close()
    await executor_http.aclose()


@pytest.mark.asyncio
async def test_anthropic_chat_round_trips_canonical_tool_results(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    model_requests: list[dict[str, Any]] = []

    class ToolBlock:
        type = "tool_use"
        id = "toolu_worker_test"
        name = "gmail__send_email"
        input: ClassVar[dict[str, Any]] = {
            "to": ["sam@example.com"],
            "subject": "Confirmed",
            "body": "Your table is confirmed.",
        }

        def model_dump(self, **_options: Any) -> dict[str, Any]:
            return {
                "type": self.type,
                "id": self.id,
                "name": self.name,
                "input": self.input,
            }

    class TextBlock:
        type = "text"
        text = "The confirmation email has been sent."

        def model_dump(self, **_options: Any) -> dict[str, Any]:
            return {"type": self.type, "text": self.text}

    class FakeMessages:
        async def create(self, **options: Any) -> Any:
            model_requests.append(options)
            content: list[ToolBlock | TextBlock] = (
                [ToolBlock()] if len(model_requests) == 1 else [TextBlock()]
            )
            return SimpleNamespace(content=content)

    class FakeAsyncAnthropic:
        def __init__(self, *, api_key: str) -> None:
            assert api_key == "anthropic-test-key"
            self.messages = FakeMessages()

        async def __aenter__(self) -> FakeAsyncAnthropic:
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

    monkeypatch.setitem(
        sys.modules,
        "anthropic",
        SimpleNamespace(AsyncAnthropic=FakeAsyncAnthropic),
    )
    dispatched: list[tuple[str, str, str, dict[str, Any]]] = []

    async def execute_tool(
        session_id: str,
        turn_id: str,
        tool: str,
        input: dict[str, Any],
    ) -> ExecutorResult:
        dispatched.append((session_id, turn_id, tool, input))
        return ExecutorResult(
            execution_id="exe_voice_chat_test",
            tool=tool,
            output={"messageId": "message_chat_test"},
        )

    config = replace(
        worker_config(tmp_path / "chat-media.sqlite3"),
        anthropic_api_key="anthropic-test-key",
    )
    factory = PipecatPipelineFactory(
        config=config,
        execute_tool=execute_tool,
        record_transcript=lambda *_args: "unused",
    )
    payload = start_payload()
    payload["transport"] = {"kind": "chat"}
    request = StartSessionRequest.model_validate(payload)
    history = [
        SimpleNamespace(
            data={
                "type": "turn.transcript",
                "speaker": "human",
                "text": "Please send my confirmation.",
            }
        )
    ]

    assistant = await factory.chat(
        "session_chat_test",
        request,
        "turn_chat_test",
        history,
    )

    assert assistant == "The confirmation email has been sent."
    assert dispatched == [
        (
            "session_chat_test",
            "turn_chat_test_tool_0_0",
            "gmail.send_email",
            ToolBlock.input,
        )
    ]
    assert model_requests[0]["tools"][0]["name"] == "gmail__send_email"
    tool_result = model_requests[1]["messages"][-1]["content"][0]
    assert tool_result == {
        "type": "tool_result",
        "tool_use_id": "toolu_worker_test",
        "content": '{"messageId":"message_chat_test"}',
        "is_error": False,
    }


@pytest.mark.asyncio
async def test_control_plane_requires_version_and_token(tmp_path: Path) -> None:
    app = create_app(config=worker_config(tmp_path / "auth.sqlite3"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://worker.test"
        ) as client:
            missing_version = await client.post(
                "/v1/sessions",
                headers={"Authorization": f"Bearer {CONTROL_TOKEN}"},
                json=start_payload(with_tool=False),
            )
            assert missing_version.status_code == 426
            assert missing_version.headers[WIRE_VERSION_HEADER] == WIRE_VERSION

            missing_token = await client.post(
                "/v1/sessions",
                headers={WIRE_VERSION_HEADER: WIRE_VERSION},
                json=start_payload(with_tool=False),
            )
            assert missing_token.status_code == 401

            health = await client.get("/health")
            assert health.status_code == 200
            assert health.headers[WIRE_VERSION_HEADER] == WIRE_VERSION
            health_body = health.json()
            assert isinstance(health_body["media"].pop("pipecatInstalled"), bool)
            assert health_body == {
                "status": "ok",
                "service": "voice-worker",
                "contractVersion": WIRE_VERSION,
                "acceptingSessions": True,
                "activeSessions": 0,
                "media": {
                    "mode": "fake",
                    "liveReady": False,
                },
            }


@pytest.mark.asyncio
async def test_twilio_dialer_authenticates_the_public_media_socket(
    tmp_path: Path,
) -> None:
    requests: list[httpx.Request] = []

    def twilio(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json={"sid": "CA_voice_worker_test"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(twilio))
    config = replace(
        worker_config(tmp_path / "twilio.sqlite3"),
        media_mode="pipecat",
        public_url="https://voice.example.test",
        twilio_account_sid="AC_voice_worker_test",
        twilio_auth_token="twilio-auth-test",
        twilio_from_number="+14155550100",
        allow_fake_transport=False,
    )
    transport = TwilioTransport.model_validate({"kind": "twilio", "to": "+14155550101"})

    call_sid = await TwilioDialer(config, client).dial("session_twilio_test", transport)

    assert call_sid == "CA_voice_worker_test"
    assert len(requests) == 1
    body = parse_qs(requests[0].content.decode())
    twiml = body["Twiml"][0]
    stream_url = twiml.split('url="', 1)[1].split('"', 1)[0]
    parsed = urlsplit(stream_url)
    assert parsed.scheme == "wss"
    assert parsed.path == "/v1/media/twilio/session_twilio_test"
    assert parse_qs(parsed.query) == {
        "token": [twilio_media_token(config, "session_twilio_test")]
    }
    await client.aclose()
