"""Pinned-scope child execution client for voice tool calls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import JsonValue

EXECUTION_ID_HEADER = "X-Eyeball-Execution-Id"


class ExecutorProtocolError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ExecutorResult:
    execution_id: str
    tool: str
    output: JsonValue | None = None
    error: dict[str, JsonValue] | None = None


class ExecutorClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = client or httpx.AsyncClient(timeout=15.0)
        self._owns_client = client is None

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def execute(
        self,
        *,
        session_id: str,
        event_sequence: int,
        execution_id: str,
        user_id: str,
        tool: str,
        input: dict[str, JsonValue],
    ) -> ExecutorResult:
        if self._api_key is None or self._api_key.strip() == "":
            raise ExecutorProtocolError(
                "EYEBALL_VOICE_WORKER_KEY is required for tool-enabled sessions."
            )
        try:
            response = await self._client.post(
                f"{self._base_url}/v1/execute",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Idempotency-Key": (
                        f"voice-session:{session_id}:event:{event_sequence}"
                    ),
                    EXECUTION_ID_HEADER: execution_id,
                },
                json={
                    "tool": tool,
                    "userId": user_id,
                    "input": input,
                    "mode": "sync",
                },
            )
        except httpx.HTTPError as request_error:
            raise ExecutorProtocolError(
                "The executor could not be reached for the child tool call."
            ) from request_error
        payload = _object(response)
        if response.status_code >= 400:
            error_payload = payload.get("error")
            if isinstance(error_payload, dict):
                return ExecutorResult(
                    execution_id=execution_id,
                    tool=tool,
                    error={str(key): value for key, value in error_payload.items()},
                )
            raise ExecutorProtocolError(
                f"Executor returned HTTP {response.status_code} "
                "without an error envelope."
            )
        if payload.get("executionId") != execution_id or payload.get("tool") != tool:
            raise ExecutorProtocolError(
                "Executor response did not preserve the reserved execution identity."
            )
        status = payload.get("status")
        if status == "succeeded" and "output" in payload:
            return ExecutorResult(
                execution_id=execution_id,
                tool=tool,
                output=payload["output"],
            )
        if status == "failed" and isinstance(payload.get("error"), dict):
            return ExecutorResult(
                execution_id=execution_id,
                tool=tool,
                error={str(key): value for key, value in payload["error"].items()},
            )
        raise ExecutorProtocolError(
            "Synchronous executor response was not terminal or lacked its result."
        )


def _object(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as error:
        raise ExecutorProtocolError("Executor returned non-JSON data.") from error
    if not isinstance(payload, dict):
        raise ExecutorProtocolError("Executor returned a non-object response.")
    return payload
