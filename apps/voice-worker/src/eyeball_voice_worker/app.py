"""FastAPI control plane for the durable, versioned voice worker."""

from __future__ import annotations

import hmac
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from .config import WorkerConfig
from .contracts import (
    WIRE_VERSION,
    WIRE_VERSION_HEADER,
    ChatTurnRequest,
    ChatTurnResponse,
    EventEnvelope,
    EventPage,
    FakeTransport,
    LiveKitTransport,
    MediaHealth,
    SessionResponse,
    StartSessionRequest,
    StopSessionRequest,
    TwilioTransport,
    WorkerHealth,
)
from .executor import ExecutorClient
from .manager import (
    InvalidTransportError,
    SessionManager,
    SessionNotFoundError,
    SessionPolicyError,
    StateConflictError,
    WorkerDrainingError,
)
from .media import (
    MediaConfigurationError,
    PipecatPipelineFactory,
    TwilioDialer,
    live_credentials_ready,
    pipecat_installed,
    twilio_media_token,
)
from .repository import VoiceSessionRepository


def create_app(
    *,
    config: WorkerConfig | None = None,
    executor_http_client: httpx.AsyncClient | None = None,
    twilio_http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    settings = config or WorkerConfig.from_env()
    repository = VoiceSessionRepository(settings.database_path)
    executor = ExecutorClient(
        base_url=settings.executor_url,
        api_key=settings.executor_key,
        client=executor_http_client,
    )
    manager = SessionManager(executor, repository)
    media = PipecatPipelineFactory(
        config=settings,
        execute_tool=manager.execute_tool_for_session,
        record_transcript=manager.record_transcript,
    )
    manager.set_chat_responder(media.chat)
    dial_client = twilio_http_client or httpx.AsyncClient(timeout=15.0)
    owns_dial_client = twilio_http_client is None
    dialer = TwilioDialer(settings, dial_client)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            await manager.recover()
            yield
        finally:
            await manager.drain(settings.drain_timeout_seconds)
            await manager.close()
            if owns_dial_client:
                await dial_client.aclose()

    app = FastAPI(title="Eyeball Voice Worker", version="0.1.0", lifespan=lifespan)
    app.state.config = settings
    app.state.manager = manager
    app.state.media = media
    app.state.repository = repository

    @app.middleware("http")
    async def secure_control_plane(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.url.path.startswith("/v1/sessions"):
            supplied_version = request.headers.get(WIRE_VERSION_HEADER)
            if supplied_version != WIRE_VERSION:
                return _error_response(
                    426,
                    "contract_version_mismatch",
                    f"{WIRE_VERSION_HEADER} must be {WIRE_VERSION}.",
                )
            if not _authorized(
                request.headers.get("authorization"), settings.control_token
            ):
                return _error_response(
                    401,
                    "auth_missing",
                    "A valid voice-worker control token is required.",
                )
        response = await call_next(request)
        response.headers[WIRE_VERSION_HEADER] = WIRE_VERSION
        return response

    @app.exception_handler(SessionNotFoundError)
    async def missing_session(
        _request: Request, _error: SessionNotFoundError
    ) -> JSONResponse:
        return _error_response(404, "session_not_found", "The session was not found.")

    @app.exception_handler(WorkerDrainingError)
    async def draining(_request: Request, error: WorkerDrainingError) -> JSONResponse:
        return _error_response(503, "worker_draining", str(error))

    @app.exception_handler(StateConflictError)
    async def state_conflict(
        _request: Request, error: StateConflictError
    ) -> JSONResponse:
        return _error_response(409, "state_conflict", str(error))

    @app.exception_handler(InvalidTransportError)
    @app.exception_handler(MediaConfigurationError)
    @app.exception_handler(SessionPolicyError)
    async def invalid_runtime(_request: Request, error: Exception) -> JSONResponse:
        return _error_response(422, "invalid_runtime", str(error))

    @app.get("/health", response_model=WorkerHealth)
    async def health() -> WorkerHealth:
        repository.check()
        return WorkerHealth(
            status="ok" if manager.accepting else "draining",
            accepting_sessions=manager.accepting,
            active_sessions=manager.active_count,
            media=MediaHealth(
                mode=settings.media_mode,
                pipecat_installed=pipecat_installed(),
                live_ready=(
                    settings.media_mode == "pipecat"
                    and pipecat_installed()
                    and live_credentials_ready(settings)
                ),
            ),
        )

    @app.post("/v1/sessions", response_model=SessionResponse, status_code=201)
    async def start_session(request: StartSessionRequest) -> SessionResponse:
        if isinstance(request.transport, FakeTransport):
            if not settings.allow_fake_transport or settings.media_mode != "fake":
                raise SessionPolicyError("Fake transport is test-only.")
        elif request.transport.kind != "chat" and settings.media_mode != "pipecat":
            raise MediaConfigurationError(
                "Live transports require EYEBALL_VOICE_MEDIA_MODE=pipecat."
            )
        session = await manager.start(request)
        try:
            if isinstance(request.transport, LiveKitTransport):
                runtime = await media.livekit(session.id, request)
                await manager.start_runtime(session.id, runtime)
            elif isinstance(request.transport, TwilioTransport):
                manager.mark_connecting(session.id)
                await dialer.dial(session.id, request.transport)
        except MediaConfigurationError as error:
            manager.fail(session.id, str(error))
            raise
        except Exception:
            manager.fail(
                session.id,
                "The provider-backed session failed to start.",
            )
            raise
        return SessionResponse(session=manager.get(session.id))

    @app.get("/v1/sessions/{session_id}", response_model=SessionResponse)
    async def get_session(session_id: str) -> SessionResponse:
        return SessionResponse(session=manager.get(session_id))

    @app.post("/v1/sessions/{session_id}/stop", response_model=SessionResponse)
    async def stop_session(
        session_id: str, _request: StopSessionRequest
    ) -> SessionResponse:
        return SessionResponse(session=await manager.stop(session_id))

    @app.get("/v1/sessions/{session_id}/events", response_model=EventPage)
    async def session_events(
        session_id: str,
        after_sequence: int = Query(default=0, alias="afterSequence", ge=0),
        limit: int = Query(default=50, ge=1, le=200),
    ) -> EventPage:
        return manager.page(session_id, after_sequence, limit)

    @app.post("/v1/sessions/{session_id}/turns", response_model=ChatTurnResponse)
    async def chat_turn(session_id: str, request: ChatTurnRequest) -> ChatTurnResponse:
        return await manager.chat_turn(session_id, request)

    @app.websocket("/v1/sessions/{session_id}/events")
    async def session_event_stream(
        websocket: WebSocket,
        session_id: str,
        after_sequence: int = Query(default=0, alias="afterSequence", ge=0),
    ) -> None:
        if websocket.headers.get(WIRE_VERSION_HEADER) != WIRE_VERSION:
            await websocket.close(code=4406, reason="contract version mismatch")
            return
        if not _authorized(
            websocket.headers.get("authorization"), settings.control_token
        ):
            await websocket.close(code=4401, reason="unauthorized")
            return
        await websocket.accept()
        try:
            queue = await manager.subscribe(session_id, after_sequence)
        except SessionNotFoundError:
            await websocket.close(code=4404, reason="session not found")
            return
        try:
            while True:
                event = await queue.get()
                await websocket.send_json(
                    EventEnvelope(event=event).model_dump(
                        by_alias=True, exclude_none=True
                    )
                )
                if event.data.get("type") == "session.lifecycle" and event.data.get(
                    "to"
                ) in {"completed", "failed", "abandoned"}:
                    await websocket.close(code=1000)
                    return
        except WebSocketDisconnect:
            return
        finally:
            manager.unsubscribe(session_id, queue)

    @app.websocket("/v1/media/twilio/{session_id}")
    async def twilio_media(websocket: WebSocket, session_id: str) -> None:
        supplied_token = websocket.query_params.get("token")
        try:
            expected_token = twilio_media_token(settings, session_id)
        except MediaConfigurationError:
            await websocket.close(code=4401, reason="unauthorized")
            return
        if supplied_token is None or not hmac.compare_digest(
            supplied_token, expected_token
        ):
            await websocket.close(code=4401, reason="unauthorized")
            return
        await websocket.accept()
        try:
            request = manager.request(session_id)
        except SessionNotFoundError:
            await websocket.close(code=4404, reason="session not found")
            return
        if not isinstance(request.transport, TwilioTransport):
            await websocket.close(code=4400, reason="not a Twilio session")
            return
        try:
            runtime = await media.twilio(session_id, request, websocket)
            await manager.start_runtime(session_id, runtime)
            await manager.wait_runtime(session_id)
        except Exception:
            manager.fail(session_id, "The Twilio media runtime failed to start.")
            raise

    return app


def _authorized(header: str | None, expected: str | None) -> bool:
    if expected is None or expected == "":
        return True
    if header is None or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header.removeprefix("Bearer "), expected)


def _error_response(status: int, code: str, message: str) -> JSONResponse:
    response = JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
    )
    response.headers[WIRE_VERSION_HEADER] = WIRE_VERSION
    return response
