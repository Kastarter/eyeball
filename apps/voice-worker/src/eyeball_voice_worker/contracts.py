"""Pydantic models for ``eyeball.voice-worker.v1``."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

WIRE_VERSION: Literal["eyeball.voice-worker.v1"] = "eyeball.voice-worker.v1"
WIRE_VERSION_HEADER = "X-Eyeball-Voice-Worker-Version"

SessionState = Literal[
    "created",
    "connecting",
    "in-progress",
    "wrap-up",
    "completed",
    "failed",
    "abandoned",
]
Transport = Literal["pstn:twilio", "webrtc:livekit", "chat"]
type CanonicalToolName = Annotated[
    str,
    Field(
        min_length=3,
        max_length=63,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
    ),
]


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        extra="forbid",
    )


class ScopeSnapshot(WireModel):
    project_id: Annotated[str, Field(min_length=1)]
    user_id: Annotated[str, Field(min_length=1)]


class AllowedToolSnapshot(WireModel):
    name: CanonicalToolName
    description: Annotated[str, Field(min_length=1)]
    input_schema: dict[str, JsonValue]


class LlmSnapshot(WireModel):
    provider: Literal["anthropic"]
    model: Annotated[str, Field(min_length=1)]
    temperature: Annotated[float, Field(ge=0, le=2)] | None = None
    max_output_tokens: Annotated[int, Field(ge=1)] | None = None


class BargeInSnapshot(WireModel):
    enabled: bool = True


class AgentSnapshot(WireModel):
    id: Annotated[str, Field(min_length=1)]
    revision: Annotated[int, Field(ge=1)]
    system_prompt: Annotated[str, Field(min_length=1)]
    llm: LlmSnapshot
    voice: dict[str, JsonValue]
    allowed_tools: list[AllowedToolSnapshot]
    guardrails: dict[str, JsonValue]
    webhooks: dict[str, JsonValue]
    recording_policy: dict[str, JsonValue]
    barge_in: BargeInSnapshot = Field(default_factory=BargeInSnapshot)


class TwilioTransport(WireModel):
    kind: Literal["twilio"]
    to: Annotated[str, Field(pattern=r"^\+[1-9][0-9]{7,14}$")]
    from_: str | None = Field(default=None, alias="from")
    transport_connection_id: str | None = None
    metadata: dict[str, JsonValue] | None = None


class LiveKitTransport(WireModel):
    kind: Literal["livekit"]
    room_name: Annotated[str, Field(min_length=1)]
    participant_identity: str | None = None
    metadata: dict[str, JsonValue] | None = None


class ChatTransport(WireModel):
    kind: Literal["chat"]
    metadata: dict[str, JsonValue] | None = None


class FakeToolCall(WireModel):
    name: CanonicalToolName
    input: dict[str, JsonValue] = Field(default_factory=dict)


class FakeTurn(WireModel):
    caller: Annotated[str, Field(min_length=1)]
    assistant: str | None = None
    tool_call: FakeToolCall | None = None
    delay_ms: Annotated[int, Field(ge=0)] = 0


class FakeTransport(WireModel):
    kind: Literal["fake"]
    turns: Annotated[list[FakeTurn], Field(min_length=1)]


type TransportSnapshot = Annotated[
    TwilioTransport | LiveKitTransport | ChatTransport | FakeTransport,
    Field(discriminator="kind"),
]


class StartSessionRequest(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"]
    scope: ScopeSnapshot
    agent: AgentSnapshot
    transport: TransportSnapshot


class PublicSession(WireModel):
    id: Annotated[str, Field(min_length=1)]
    project_id: Annotated[str, Field(min_length=1)]
    agent_id: Annotated[str, Field(min_length=1)]
    agent_revision: Annotated[int, Field(ge=1)]
    transport: Transport
    state: SessionState
    user_id: Annotated[str, Field(min_length=1)]
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    last_event_sequence: Annotated[int, Field(ge=0)]
    error: dict[str, JsonValue] | None = None


class SessionEvent(WireModel):
    id: Annotated[str, Field(min_length=1)]
    session_id: Annotated[str, Field(min_length=1)]
    sequence: Annotated[int, Field(ge=1)]
    created_at: str
    data: dict[str, JsonValue]


class SessionResponse(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"] = WIRE_VERSION
    session: PublicSession


class StopSessionRequest(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"]
    reason: str | None = None


class EventPage(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"] = WIRE_VERSION
    events: list[SessionEvent]
    next_sequence: Annotated[int, Field(ge=0)]
    has_more: bool


class EventEnvelope(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"] = WIRE_VERSION
    event: SessionEvent


class ChatTurnRequest(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"]
    text: Annotated[str, Field(min_length=1)]
    idempotency_key: Annotated[str, Field(min_length=1)]


class ChatTurnResponse(WireModel):
    contract_version: Literal["eyeball.voice-worker.v1"] = WIRE_VERSION
    session: PublicSession
    turn_id: Annotated[str, Field(min_length=1)]
    assistant_message: str


class MediaHealth(WireModel):
    mode: Literal["fake", "pipecat"]
    pipecat_installed: bool
    live_ready: bool


class WorkerHealth(WireModel):
    status: Literal["ok", "draining"]
    service: Literal["voice-worker"] = "voice-worker"
    contract_version: Literal["eyeball.voice-worker.v1"] = WIRE_VERSION
    accepting_sessions: bool
    active_sessions: Annotated[int, Field(ge=0)]
    media: MediaHealth


class ErrorDetail(WireModel):
    code: str
    message: str


class ErrorEnvelope(WireModel):
    error: ErrorDetail


def json_object(value: Any, field: str) -> dict[str, JsonValue]:
    """Narrow decoded JSON without exposing repository-owned mutable objects."""
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be a JSON object.")
    return {str(key): item for key, item in value.items()}
