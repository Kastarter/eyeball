"""Pinned-scope child execution client for voice tool calls."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import JsonValue

EXECUTION_ID_HEADER = "X-Eyeball-Execution-Id"
VOICE_SESSION_ID_HEADER = "X-Eyeball-Voice-Session-Id"
type ExecutorAuthMode = Literal["session-grant", "static-pinned"]


class ExecutorProtocolError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ExecutorResult:
    execution_id: str
    tool: str
    output: JsonValue | None = None
    error: dict[str, JsonValue] | None = None


@dataclass(frozen=True, slots=True)
class SessionExecutorCredential:
    mode: ExecutorAuthMode
    grant_token: str | None = None


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

    @property
    def has_static_key(self) -> bool:
        return self._api_key is not None and self._api_key.strip() != ""

    async def execute(
        self,
        *,
        session_id: str,
        event_sequence: int,
        execution_id: str,
        user_id: str,
        tool: str,
        input: dict[str, JsonValue],
        credential: SessionExecutorCredential,
    ) -> ExecutorResult:
        if credential.mode == "session-grant":
            bearer = credential.grant_token
            if bearer is None or bearer.strip() == "":
                raise ExecutorProtocolError(
                    "The active voice session grant is unavailable."
                )
        else:
            bearer = self._api_key
        if bearer is None or bearer.strip() == "":
            raise ExecutorProtocolError(
                "EYEBALL_VOICE_WORKER_KEY is required for tool-enabled sessions."
            )
        headers = {
            "Authorization": f"Bearer {bearer}",
            "Idempotency-Key": (
                f"voice-session:{session_id}:event:{event_sequence}"
            ),
            EXECUTION_ID_HEADER: execution_id,
            VOICE_SESSION_ID_HEADER: session_id,
        }
        body = {
            "tool": tool,
            "userId": user_id,
            "input": input,
            "mode": "sync",
        }
        try:
            response = await self._client.post(
                f"{self._base_url}/v1/execute", headers=headers, json=body
            )
        except httpx.HTTPError as request_error:
            raise ExecutorProtocolError(
                "The executor could not be reached for the child tool call."
            ) from request_error
        payload = _object(response)
        if response.status_code >= 400:
            error_payload = payload.get("error")
            if isinstance(error_payload, dict):
                if _rejected_sync_mode(error_payload):
                    return await self._execute_async(
                        headers=headers,
                        body=body,
                        execution_id=execution_id,
                        tool=tool,
                        bearer=bearer,
                    )
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
        if status in {"failed", "cancelled"} and isinstance(
            payload.get("error"), dict
        ):
            return ExecutorResult(
                execution_id=execution_id,
                tool=tool,
                error={str(key): value for key, value in payload["error"].items()},
            )
        raise ExecutorProtocolError(
            "Synchronous executor response was not terminal or lacked its result."
        )

    async def _execute_async(
        self,
        *,
        headers: dict[str, str],
        body: dict[str, Any],
        execution_id: str,
        tool: str,
        bearer: str,
    ) -> ExecutorResult:
        # Async-by-nature tools (for example twilio.start_call) reject sync
        # admission; resubmit async and poll the execution to terminal.
        try:
            response = await self._client.post(
                f"{self._base_url}/v1/execute",
                headers=headers,
                json={**body, "mode": "async"},
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
        terminal = _terminal_result(payload, execution_id, tool)
        if terminal is not None:
            return terminal
        deadline = asyncio.get_event_loop().time() + ASYNC_POLL_TIMEOUT_SECONDS
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(ASYNC_POLL_INTERVAL_SECONDS)
            try:
                poll = await self._client.get(
                    f"{self._base_url}/v1/executions/{execution_id}",
                    headers={"Authorization": f"Bearer {bearer}"},
                )
            except httpx.HTTPError:
                continue
            if poll.status_code >= 400:
                # The session grant may not authorize execution reads; the
                # dispatch itself is durable, so report it rather than fail.
                return ExecutorResult(
                    execution_id=execution_id,
                    tool=tool,
                    output={"status": "pending", "executionId": execution_id},
                )
            terminal = _terminal_result(_object(poll), execution_id, tool)
            if terminal is not None:
                return terminal
        return ExecutorResult(
            execution_id=execution_id,
            tool=tool,
            output={"status": "running", "executionId": execution_id},
        )


ASYNC_POLL_TIMEOUT_SECONDS = 30.0
ASYNC_POLL_INTERVAL_SECONDS = 1.0


def _rejected_sync_mode(error_payload: dict[str, Any]) -> bool:
    return error_payload.get("code") == "invalid_input" and "async by nature" in str(
        error_payload.get("message", "")
    )


def _terminal_result(
    payload: dict[str, Any], execution_id: str, tool: str
) -> ExecutorResult | None:
    status = payload.get("status")
    if status == "succeeded" and "output" in payload:
        return ExecutorResult(
            execution_id=execution_id, tool=tool, output=payload["output"]
        )
    if status in {"failed", "cancelled"} and isinstance(payload.get("error"), dict):
        return ExecutorResult(
            execution_id=execution_id,
            tool=tool,
            error={str(key): value for key, value in payload["error"].items()},
        )
    return None


def _object(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as error:
        raise ExecutorProtocolError("Executor returned non-JSON data.") from error
    if not isinstance(payload, dict):
        raise ExecutorProtocolError("Executor returned a non-object response.")
    return payload
