"""SQLite durability for voice sessions, events, and pending tool dispatches."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn, cast

from pydantic import JsonValue

from .contracts import (
    WIRE_VERSION,
    ChatTurnResponse,
    EventPage,
    PublicSession,
    SessionEvent,
    StartSessionRequest,
    json_object,
)

TERMINAL_STATES = {"completed", "failed", "abandoned"}
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "created": {"connecting", "in-progress", "failed", "abandoned"},
    "connecting": {"in-progress", "failed", "abandoned"},
    "in-progress": {"wrap-up", "failed", "abandoned"},
    "wrap-up": {"completed", "failed"},
    "completed": set(),
    "failed": set(),
    "abandoned": set(),
}


class RepositoryError(RuntimeError):
    pass


class SessionNotFoundError(RepositoryError):
    pass


class StateConflictError(RepositoryError):
    pass


@dataclass(frozen=True, slots=True)
class PendingToolCall:
    event_sequence: int
    execution_id: str
    turn_id: str
    tool: str
    input: dict[str, JsonValue]


@dataclass(frozen=True, slots=True)
class StoredSession:
    request: StartSessionRequest
    session: PublicSession
    runtime_cursor: int
    next_turn: int
    pending_tool: PendingToolCall | None
    executor_auth_mode: str
    executor_grant_token: str | None
    executor_grant_expires_at: str | None
    executor_grant_revoked_at: str | None


def _encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _now() -> str:
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


class VoiceSessionRepository:
    """Serializes writes so each session has one gap-free durable event log."""

    def __init__(self, path: Path) -> None:
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags, 0o600)
            try:
                os.fchmod(descriptor, 0o600)
            finally:
                os.close(descriptor)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            str(path),
            timeout=30,
            isolation_level=None,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        if str(path) != ":memory:":
            self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.execute("PRAGMA busy_timeout=30000")
        self._migrate()

    def _migrate(self) -> None:
        with self._lock:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS voice_sessions (
                  id TEXT PRIMARY KEY,
                  request_json TEXT NOT NULL,
                  session_json TEXT NOT NULL,
                  runtime_cursor INTEGER NOT NULL DEFAULT 0 CHECK(runtime_cursor >= 0),
                  next_turn INTEGER NOT NULL DEFAULT 0 CHECK(next_turn >= 0),
                  pending_tool_json TEXT,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS voice_session_events (
                  id TEXT PRIMARY KEY,
                  session_id TEXT NOT NULL
                    REFERENCES voice_sessions(id) ON DELETE CASCADE,
                  event_key TEXT NOT NULL,
                  sequence INTEGER NOT NULL CHECK(sequence > 0),
                  created_at TEXT NOT NULL,
                  data_json TEXT NOT NULL,
                  UNIQUE(session_id, event_key),
                  UNIQUE(session_id, sequence)
                );

                CREATE TABLE IF NOT EXISTS voice_session_executor_auth (
                  session_id TEXT PRIMARY KEY
                    REFERENCES voice_sessions(id) ON DELETE CASCADE,
                  mode TEXT NOT NULL
                    CHECK(mode IN ('session-grant', 'static-pinned')),
                  grant_token TEXT,
                  grant_expires_at TEXT,
                  grant_revoked_at TEXT,
                  created_at TEXT NOT NULL,
                  CHECK(
                    (mode = 'static-pinned'
                      AND grant_token IS NULL
                      AND grant_expires_at IS NULL
                      AND grant_revoked_at IS NULL)
                    OR
                    (mode = 'session-grant'
                      AND grant_expires_at IS NOT NULL
                      AND (
                        (grant_token IS NOT NULL AND grant_revoked_at IS NULL)
                        OR
                        (grant_token IS NULL AND grant_revoked_at IS NOT NULL)
                      ))
                  )
                );

                CREATE TABLE IF NOT EXISTS voice_chat_receipts (
                  session_id TEXT NOT NULL
                    REFERENCES voice_sessions(id) ON DELETE CASCADE,
                  idempotency_key TEXT NOT NULL,
                  request_json TEXT NOT NULL,
                  response_json TEXT NOT NULL,
                  PRIMARY KEY(session_id, idempotency_key)
                );

                CREATE INDEX IF NOT EXISTS voice_events_session_sequence
                  ON voice_session_events(session_id, sequence);
                """
            )

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cursor = self._connection.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                yield cursor
            except BaseException:
                cursor.execute("ROLLBACK")
                raise
            else:
                cursor.execute("COMMIT")
            finally:
                cursor.close()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def check(self) -> None:
        with self._lock:
            self._connection.execute("SELECT 1").fetchone()

    def create(
        self, request: StartSessionRequest, session: PublicSession
    ) -> StoredSession:
        if request.session_id != session.id:
            raise RepositoryError(
                "The stored session ID must match the executor-owned request ID."
            )
        encoded_request = _encode(
            request.model_dump(
                by_alias=True,
                exclude_none=True,
                exclude={"executor_grant"},
            )
        )
        with self._transaction() as cursor:
            cursor.execute(
                """
                INSERT INTO voice_sessions (
                  id, request_json, session_json, updated_at
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    session.id,
                    encoded_request,
                    _encode(session.model_dump(by_alias=True, exclude_none=True)),
                    _now(),
                ),
            )
            grant = request.executor_grant
            cursor.execute(
                """
                INSERT INTO voice_session_executor_auth (
                  session_id, mode, grant_token, grant_expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    "session-grant" if grant is not None else "static-pinned",
                    None if grant is None else grant.token,
                    (
                        None
                        if grant is None
                        else grant.expires_at.isoformat().replace("+00:00", "Z")
                    ),
                    _now(),
                ),
            )
            row = self._row(cursor, session.id)
            self._append_event(
                cursor,
                row,
                "lifecycle:created",
                {"type": "session.lifecycle", "to": "created"},
            )
            return self._stored(row)

    def get(self, session_id: str) -> StoredSession:
        with self._lock:
            record = self._connection.execute(
                self._session_auth_query("WHERE sessions.id = ?"), (session_id,)
            ).fetchone()
            if record is None:
                self._not_found()
            return self._stored(dict(record))

    def active(self) -> list[StoredSession]:
        with self._lock:
            records = self._connection.execute(
                self._session_auth_query(
                    "ORDER BY sessions.updated_at ASC, sessions.id ASC"
                )
            ).fetchall()
        stored = [self._stored(dict(record)) for record in records]
        return [item for item in stored if item.session.state not in TERMINAL_STATES]

    def active_count(self) -> int:
        return len(self.active())

    def page(self, session_id: str, after_sequence: int, limit: int) -> EventPage:
        if after_sequence < 0:
            raise ValueError("afterSequence must be non-negative.")
        if limit < 1 or limit > 200:
            raise ValueError("limit must be from 1 through 200.")
        with self._lock:
            if (
                self._connection.execute(
                    "SELECT 1 FROM voice_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                is None
            ):
                self._not_found()
            records = self._connection.execute(
                """
                SELECT * FROM voice_session_events
                WHERE session_id = ? AND sequence > ?
                ORDER BY sequence ASC LIMIT ?
                """,
                (session_id, after_sequence, limit + 1),
            ).fetchall()
        has_more = len(records) > limit
        events = [self._event(record) for record in records[:limit]]
        return EventPage(
            events=events,
            next_sequence=events[-1].sequence if events else after_sequence,
            has_more=has_more,
        )

    def event(self, session_id: str, event_key: str) -> SessionEvent | None:
        with self._lock:
            if (
                self._connection.execute(
                    "SELECT 1 FROM voice_sessions WHERE id = ?", (session_id,)
                ).fetchone()
                is None
            ):
                self._not_found()
            record = self._connection.execute(
                """
                SELECT * FROM voice_session_events
                WHERE session_id = ? AND event_key = ?
                """,
                (session_id, event_key),
            ).fetchone()
            return None if record is None else self._event(record)

    def append_event(
        self,
        session_id: str,
        event_key: str,
        data: dict[str, JsonValue],
    ) -> SessionEvent:
        with self._transaction() as cursor:
            row = self._row(cursor, session_id)
            return self._append_event(cursor, row, event_key, data)

    def transition(
        self,
        session_id: str,
        target: str,
        *,
        error: dict[str, JsonValue] | None = None,
    ) -> PublicSession:
        with self._transaction() as cursor:
            row = self._row(cursor, session_id)
            session = self._session(row)
            current = session.state
            if current == target:
                if target in TERMINAL_STATES:
                    self._clear_grant(cursor, session_id, _now())
                return session
            if current in TERMINAL_STATES or target not in ALLOWED_TRANSITIONS[current]:
                raise StateConflictError(
                    f"Voice session cannot transition from {current} to {target}."
                )
            now = _now()
            update: dict[str, Any] = {"state": target}
            if target == "in-progress" and session.started_at is None:
                update["started_at"] = now
            if target in TERMINAL_STATES:
                update["completed_at"] = now
            if error is not None:
                update["error"] = error
            session = session.model_copy(update=update)
            row["session_json"] = _encode(
                session.model_dump(by_alias=True, exclude_none=True)
            )
            cursor.execute(
                """
                UPDATE voice_sessions SET session_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (row["session_json"], now, session_id),
            )
            if target in TERMINAL_STATES:
                self._clear_grant(cursor, session_id, now)
            self._append_event(
                cursor,
                row,
                f"lifecycle:{current}:{target}",
                {"type": "session.lifecycle", "from": current, "to": target},
            )
            return self._session(row)

    def increment_turn(self, session_id: str) -> int:
        with self._transaction() as cursor:
            row = self._row(cursor, session_id)
            value = int(row["next_turn"]) + 1
            cursor.execute(
                "UPDATE voice_sessions SET next_turn = ?, updated_at = ? WHERE id = ?",
                (value, _now(), session_id),
            )
            return value

    def set_runtime_cursor(self, session_id: str, cursor_value: int) -> None:
        if cursor_value < 0:
            raise ValueError("runtime cursor must be non-negative.")
        with self._transaction() as cursor:
            self._row(cursor, session_id)
            cursor.execute(
                """
                UPDATE voice_sessions
                SET runtime_cursor = MAX(runtime_cursor, ?), updated_at = ?
                WHERE id = ?
                """,
                (cursor_value, _now(), session_id),
            )

    def create_tool_call(
        self,
        session_id: str,
        *,
        event_key: str,
        turn_id: str,
        execution_id: str,
        tool: str,
        input: dict[str, JsonValue],
        runtime_cursor: int | None = None,
    ) -> tuple[PendingToolCall, SessionEvent]:
        if runtime_cursor is not None and runtime_cursor < 0:
            raise ValueError("runtime cursor must be non-negative.")
        pending = PendingToolCall(
            event_sequence=0,
            execution_id=execution_id,
            turn_id=turn_id,
            tool=tool,
            input=input,
        )
        with self._transaction() as cursor:
            row = self._row(cursor, session_id)
            existing = self._pending(row)
            if existing is not None:
                if (
                    existing.execution_id != execution_id
                    or existing.turn_id != turn_id
                    or existing.tool != tool
                    or existing.input != input
                ):
                    raise StateConflictError(
                        "The session already has a different pending tool call."
                    )
                if (
                    runtime_cursor is not None
                    and int(row["runtime_cursor"]) < runtime_cursor
                ):
                    cursor.execute(
                        """
                        UPDATE voice_sessions SET runtime_cursor = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (runtime_cursor, _now(), session_id),
                    )
                event = self._event_by_key(cursor, session_id, event_key)
                if event is None:
                    raise StateConflictError(
                        "The pending tool call has no durable call event."
                    )
                return existing, event
            event = self._append_event(
                cursor,
                row,
                event_key,
                {
                    "type": "tool_call",
                    "turnId": turn_id,
                    "executionId": execution_id,
                    "tool": tool,
                    "input": input,
                },
            )
            pending = PendingToolCall(
                event_sequence=event.sequence,
                execution_id=execution_id,
                turn_id=turn_id,
                tool=tool,
                input=input,
            )
            cursor.execute(
                """
                UPDATE voice_sessions
                SET pending_tool_json = ?,
                    runtime_cursor = COALESCE(?, runtime_cursor),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _encode(asdict(pending)),
                    runtime_cursor,
                    _now(),
                    session_id,
                ),
            )
            return pending, event

    def complete_tool_call(
        self,
        session_id: str,
        *,
        execution_id: str,
        result: dict[str, JsonValue],
    ) -> SessionEvent:
        with self._transaction() as cursor:
            row = self._row(cursor, session_id)
            pending = self._pending(row)
            event_key = f"tool-result:{execution_id}"
            if pending is None:
                event = self._event_by_key(
                    cursor,
                    session_id,
                    event_key,
                    required=False,
                )
                if event is None:
                    raise StateConflictError("The session has no pending tool call.")
                expected = json_object(event.data, "stored tool result")
                if any(expected.get(key) != value for key, value in result.items()):
                    raise StateConflictError(
                        "The execution ID already has a different durable result."
                    )
                return event
            if pending.execution_id != execution_id:
                raise StateConflictError(
                    "The tool result execution ID does not match the pending call."
                )
            data: dict[str, JsonValue] = {
                "type": "tool_result",
                "turnId": pending.turn_id,
                "executionId": pending.execution_id,
                "tool": pending.tool,
                **result,
            }
            event = self._append_event(cursor, row, event_key, data)
            cursor.execute(
                """
                UPDATE voice_sessions SET pending_tool_json = NULL, updated_at = ?
                WHERE id = ?
                """,
                (_now(), session_id),
            )
            return event

    def chat_receipt(
        self, session_id: str, idempotency_key: str, request_json: str
    ) -> ChatTurnResponse | None:
        with self._lock:
            record = self._connection.execute(
                """
                SELECT request_json, response_json FROM voice_chat_receipts
                WHERE session_id = ? AND idempotency_key = ?
                """,
                (session_id, idempotency_key),
            ).fetchone()
        if record is None:
            return None
        if record["request_json"] != request_json:
            raise StateConflictError(
                "The chat idempotency key was reused with different input."
            )
        return ChatTurnResponse.model_validate(json.loads(record["response_json"]))

    def remember_chat_receipt(
        self,
        session_id: str,
        idempotency_key: str,
        request_json: str,
        response: ChatTurnResponse,
    ) -> None:
        with self._transaction() as cursor:
            self._row(cursor, session_id)
            cursor.execute(
                """
                INSERT INTO voice_chat_receipts (
                  session_id, idempotency_key, request_json, response_json
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    session_id,
                    idempotency_key,
                    request_json,
                    _encode(response.model_dump(by_alias=True, exclude_none=True)),
                ),
            )

    def _row(self, cursor: sqlite3.Cursor, session_id: str) -> dict[str, Any]:
        record = cursor.execute(
            self._session_auth_query("WHERE sessions.id = ?"), (session_id,)
        ).fetchone()
        if record is None:
            self._not_found()
        return dict(record)

    @staticmethod
    def _not_found() -> NoReturn:
        raise SessionNotFoundError("The session was not found.")

    def _stored(self, row: dict[str, Any]) -> StoredSession:
        request_value = json_object(
            json.loads(row["request_json"]), "stored session request"
        )
        legacy_request = (
            request_value.get("contractVersion") == "eyeball.voice-worker.v1"
            and "sessionId" not in request_value
        )
        if legacy_request:
            request_value = {
                **request_value,
                "contractVersion": WIRE_VERSION,
                "sessionId": cast(str, row["id"]),
            }
        executor_auth_mode = row.get("executor_auth_mode")
        if executor_auth_mode is None:
            if not legacy_request:
                raise RepositoryError(
                    "The v2 session executor authorization row is missing."
                )
            executor_auth_mode = "static-pinned"
        return StoredSession(
            request=StartSessionRequest.model_validate(request_value),
            session=self._session(row),
            runtime_cursor=int(row["runtime_cursor"]),
            next_turn=int(row["next_turn"]),
            pending_tool=self._pending(row),
            executor_auth_mode=cast(str, executor_auth_mode),
            executor_grant_token=cast(str | None, row.get("executor_grant_token")),
            executor_grant_expires_at=cast(
                str | None, row.get("executor_grant_expires_at")
            ),
            executor_grant_revoked_at=cast(
                str | None, row.get("executor_grant_revoked_at")
            ),
        )

    @staticmethod
    def _session_auth_query(suffix: str) -> str:
        return f"""
            SELECT
              sessions.*,
              auth.mode AS executor_auth_mode,
              auth.grant_token AS executor_grant_token,
              auth.grant_expires_at AS executor_grant_expires_at,
              auth.grant_revoked_at AS executor_grant_revoked_at
            FROM voice_sessions AS sessions
            LEFT JOIN voice_session_executor_auth AS auth
              ON auth.session_id = sessions.id
            {suffix}
        """

    @staticmethod
    def _clear_grant(
        cursor: sqlite3.Cursor, session_id: str, revoked_at: str
    ) -> None:
        cursor.execute(
            """
            UPDATE voice_session_executor_auth
            SET grant_token = NULL,
                grant_revoked_at = COALESCE(grant_revoked_at, ?)
            WHERE session_id = ? AND mode = 'session-grant'
            """,
            (revoked_at, session_id),
        )

    @staticmethod
    def _session(row: dict[str, Any]) -> PublicSession:
        return PublicSession.model_validate(json.loads(row["session_json"]))

    @staticmethod
    def _pending(row: dict[str, Any]) -> PendingToolCall | None:
        encoded = row["pending_tool_json"]
        if encoded is None:
            return None
        value = json.loads(encoded)
        return PendingToolCall(
            event_sequence=int(value["event_sequence"]),
            execution_id=cast(str, value["execution_id"]),
            turn_id=cast(str, value["turn_id"]),
            tool=cast(str, value["tool"]),
            input=json_object(value["input"], "pending tool input"),
        )

    @staticmethod
    def _event(record: sqlite3.Row) -> SessionEvent:
        return SessionEvent(
            id=record["id"],
            session_id=record["session_id"],
            sequence=record["sequence"],
            created_at=record["created_at"],
            data=json_object(json.loads(record["data_json"]), "event data"),
        )

    def _event_by_key(
        self,
        cursor: sqlite3.Cursor,
        session_id: str,
        event_key: str,
        *,
        required: bool = True,
    ) -> SessionEvent | None:
        record = cursor.execute(
            """
            SELECT * FROM voice_session_events
            WHERE session_id = ? AND event_key = ?
            """,
            (session_id, event_key),
        ).fetchone()
        if record is None and required:
            raise StateConflictError("The expected durable event is missing.")
        return None if record is None else self._event(record)

    def _append_event(
        self,
        cursor: sqlite3.Cursor,
        row: dict[str, Any],
        event_key: str,
        data: dict[str, JsonValue],
    ) -> SessionEvent:
        existing = self._event_by_key(
            cursor, cast(str, row["id"]), event_key, required=False
        )
        if existing is not None:
            if existing.data != data:
                raise StateConflictError(
                    "A durable event key was reused with different data."
                )
            return existing
        session = self._session(row)
        sequence = session.last_event_sequence + 1
        event = SessionEvent(
            id=f"event_{session.id}_{sequence:08d}",
            session_id=session.id,
            sequence=sequence,
            created_at=_now(),
            data=data,
        )
        cursor.execute(
            """
            INSERT INTO voice_session_events (
              id, session_id, event_key, sequence, created_at, data_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.session_id,
                event_key,
                event.sequence,
                event.created_at,
                _encode(event.data),
            ),
        )
        session = session.model_copy(update={"last_event_sequence": sequence})
        row["session_json"] = _encode(
            session.model_dump(by_alias=True, exclude_none=True)
        )
        cursor.execute(
            """
            UPDATE voice_sessions SET session_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (row["session_json"], _now(), session.id),
        )
        return event
