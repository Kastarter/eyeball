"""Environment-backed worker configuration with conservative defaults."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit


def _positive_float(env: Mapping[str, str], name: str, fallback: float) -> float:
    encoded = env.get(name)
    if encoded is None or encoded.strip() == "":
        return fallback
    try:
        value = float(encoded)
    except ValueError as error:
        raise ValueError(f"{name} must be a positive number.") from error
    if value <= 0:
        raise ValueError(f"{name} must be a positive number.")
    return value


def _port(env: Mapping[str, str]) -> int:
    encoded = env.get("PORT", "8080")
    try:
        value = int(encoded)
    except ValueError as error:
        raise ValueError("PORT must be an integer from 1 through 65535.") from error
    if value < 1 or value > 65_535:
        raise ValueError("PORT must be an integer from 1 through 65535.")
    return value


def _optional(env: Mapping[str, str], name: str) -> str | None:
    encoded = env.get(name)
    if encoded is None:
        return None
    value = encoded.strip()
    return value or None


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    database_path: Path
    host: str = "0.0.0.0"
    port: int = 8080
    drain_timeout_seconds: float = 25.0
    media_mode: Literal["fake", "pipecat"] = "pipecat"
    executor_url: str = "http://127.0.0.1:8787"
    executor_key: str | None = None
    control_token: str | None = None
    public_url: str | None = None
    anthropic_api_key: str | None = None
    deepgram_api_key: str | None = None
    elevenlabs_api_key: str | None = None
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    livekit_url: str | None = None
    livekit_api_key: str | None = None
    livekit_api_secret: str | None = None
    allow_fake_transport: bool = False

    def __post_init__(self) -> None:
        if self.database_path.name == "":
            raise ValueError("EYEBALL_VOICE_DATABASE_PATH must name a file.")
        if self.port < 1 or self.port > 65_535:
            raise ValueError("PORT must be an integer from 1 through 65535.")
        if self.drain_timeout_seconds <= 0:
            raise ValueError("EYEBALL_VOICE_DRAIN_SECONDS must be positive.")
        parsed_executor = urlsplit(self.executor_url)
        if (
            parsed_executor.scheme not in {"http", "https"}
            or not parsed_executor.netloc
        ):
            raise ValueError("EYEBALL_EXECUTOR_URL must be an absolute HTTP(S) URL.")
        if self.media_mode == "pipecat":
            control_token = (self.control_token or "").strip()
            if len(control_token.encode()) < 32:
                raise ValueError(
                    "EYEBALL_VOICE_WORKER_TOKEN must contain at least 32 bytes "
                    "in pipecat media mode."
                )
        if self.public_url is not None:
            parsed_public = urlsplit(self.public_url)
            if (
                parsed_public.scheme not in {"http", "https"}
                or not parsed_public.netloc
            ):
                raise ValueError(
                    "EYEBALL_VOICE_PUBLIC_URL must be an absolute HTTP(S) URL."
                )

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> WorkerConfig:
        source = os.environ if env is None else env
        raw_media_mode = source.get("EYEBALL_VOICE_MEDIA_MODE", "pipecat").strip()
        if raw_media_mode not in {"fake", "pipecat"}:
            raise ValueError("EYEBALL_VOICE_MEDIA_MODE must be fake or pipecat.")
        media_mode = cast(Literal["fake", "pipecat"], raw_media_mode)
        database_path = Path(
            source.get(
                "EYEBALL_VOICE_DATABASE_PATH",
                ".eyeball/voice-worker.sqlite3",
            )
        ).expanduser()
        if database_path.name == "":
            raise ValueError("EYEBALL_VOICE_DATABASE_PATH must name a file.")
        executor_url = source.get(
            "EYEBALL_EXECUTOR_URL", "http://127.0.0.1:8787"
        ).rstrip("/")
        return cls(
            database_path=database_path,
            host=source.get("HOST", "0.0.0.0"),
            port=_port(source),
            drain_timeout_seconds=_positive_float(
                source, "EYEBALL_VOICE_DRAIN_SECONDS", 25.0
            ),
            media_mode=media_mode,
            executor_url=executor_url,
            executor_key=_optional(source, "EYEBALL_VOICE_WORKER_KEY"),
            control_token=_optional(source, "EYEBALL_VOICE_WORKER_TOKEN"),
            public_url=_optional(source, "EYEBALL_VOICE_PUBLIC_URL"),
            anthropic_api_key=_optional(source, "ANTHROPIC_API_KEY"),
            deepgram_api_key=_optional(source, "DEEPGRAM_API_KEY"),
            elevenlabs_api_key=_optional(source, "ELEVENLABS_API_KEY"),
            twilio_account_sid=_optional(source, "TWILIO_ACCOUNT_SID"),
            twilio_auth_token=_optional(source, "TWILIO_AUTH_TOKEN"),
            twilio_from_number=_optional(source, "TWILIO_FROM_NUMBER"),
            livekit_url=_optional(source, "LIVEKIT_URL"),
            livekit_api_key=_optional(source, "LIVEKIT_API_KEY"),
            livekit_api_secret=_optional(source, "LIVEKIT_API_SECRET"),
            allow_fake_transport=source.get(
                "EYEBALL_VOICE_ALLOW_FAKE_TRANSPORT", "false"
            ).lower()
            == "true",
        )
