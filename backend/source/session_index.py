from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


SESSION_INDEX_SCHEMA_VERSION = 1


def default_session_index_path() -> Path:
    override = os.environ.get("CODEX_TOKEN_DASHBOARD_SESSION_INDEX_PATH")
    if override:
        return Path(override).expanduser()
    roaming = os.environ.get("APPDATA")
    base = Path(roaming) if roaming else Path.home() / "AppData" / "Roaming"
    return base / "codex-token-dashboard" / "session-index.sqlite3"


class PersistentSessionIndex:
    """Persistent per-file parse index for append-heavy Codex JSONL logs.

    Entries are accepted only when the exact file size and mtime still match.
    The stored payload contains normalized usage facts, never source prompts or
    assistant message text.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or default_session_index_path())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            self.path,
            timeout=10,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.execute(
                """CREATE TABLE IF NOT EXISTS parsed_sessions (
                    path TEXT PRIMARY KEY,
                    size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    schema_version INTEGER NOT NULL,
                    session_json TEXT,
                    counts_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )"""
            )
            self._connection.execute(
                "CREATE INDEX IF NOT EXISTS parsed_sessions_updated ON parsed_sessions(updated_at)"
            )

    def load(
        self,
        path: Path,
        *,
        size: int,
        mtime_ns: int,
    ) -> tuple[dict[str, Any] | None, dict[str, int]] | None:
        with self._lock:
            row = self._connection.execute(
                """SELECT session_json, counts_json
                   FROM parsed_sessions
                   WHERE path = ? AND size = ? AND mtime_ns = ? AND schema_version = ?""",
                (str(path), int(size), int(mtime_ns), SESSION_INDEX_SCHEMA_VERSION),
            ).fetchone()
        if row is None:
            return None
        try:
            session = json.loads(row["session_json"]) if row["session_json"] else None
            counts = json.loads(row["counts_json"])
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        if session is not None and not isinstance(session, dict):
            return None
        if not isinstance(counts, dict):
            return None
        return session, {str(key): int(value or 0) for key, value in counts.items()}

    def store(
        self,
        path: Path,
        *,
        size: int,
        mtime_ns: int,
        session: dict[str, Any] | None,
        counts: dict[str, int],
    ) -> None:
        session_json = (
            json.dumps(session, ensure_ascii=False, separators=(",", ":"))
            if session is not None
            else None
        )
        counts_json = json.dumps(counts, ensure_ascii=False, separators=(",", ":"))
        now = int(time.time())
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO parsed_sessions(
                       path, size, mtime_ns, schema_version, session_json, counts_json, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(path) DO UPDATE SET
                       size = excluded.size,
                       mtime_ns = excluded.mtime_ns,
                       schema_version = excluded.schema_version,
                       session_json = excluded.session_json,
                       counts_json = excluded.counts_json,
                       updated_at = excluded.updated_at""",
                (
                    str(path),
                    int(size),
                    int(mtime_ns),
                    SESSION_INDEX_SCHEMA_VERSION,
                    session_json,
                    counts_json,
                    now,
                ),
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()


_INDEX_LOCK = threading.Lock()
_INDEX: PersistentSessionIndex | None = None


def persistent_session_index() -> PersistentSessionIndex:
    global _INDEX
    with _INDEX_LOCK:
        if _INDEX is None:
            _INDEX = PersistentSessionIndex()
        return _INDEX
