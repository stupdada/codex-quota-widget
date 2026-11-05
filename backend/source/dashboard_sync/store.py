from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .crypto import protect_secret, unprotect_secret
from .protocol import DeviceCredentials, SyncEnvelope, canonical_json


class SyncStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.execute("PRAGMA foreign_keys=ON")
        self._migrate()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _migrate(self) -> None:
        statements = [
            """CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS indexed_files (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                offset INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS events (
                event_fingerprint TEXT PRIMARY KEY,
                value_fingerprint TEXT NOT NULL,
                source_device_id TEXT NOT NULL,
                source_kind TEXT NOT NULL CHECK(source_kind IN ('local', 'remote')),
                event_at INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                envelope_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )""",
            "CREATE INDEX IF NOT EXISTS events_range ON events(event_at, source_kind)",
            """CREATE TABLE IF NOT EXISTS outgoing (
                event_fingerprint TEXT PRIMARY KEY,
                envelope_json TEXT NOT NULL,
                queued_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            )""",
            """CREATE TABLE IF NOT EXISTS active_intervals (
                source_kind TEXT NOT NULL CHECK(source_kind IN ('local', 'remote')),
                source_device_id TEXT NOT NULL,
                interval_key TEXT NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(source_kind, source_device_id, interval_key)
            )""",
            "CREATE INDEX IF NOT EXISTS active_intervals_range ON active_intervals(start_ms, end_ms, source_kind)",
            """CREATE TABLE IF NOT EXISTS conflicts (
                event_fingerprint TEXT NOT NULL,
                value_fingerprint TEXT NOT NULL,
                source_device_id TEXT NOT NULL,
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                PRIMARY KEY(event_fingerprint, value_fingerprint)
            )""",
            """CREATE TABLE IF NOT EXISTS quota_observations (
                observed_at_ms INTEGER PRIMARY KEY,
                five_hour_remaining REAL,
                five_hour_reset_at_ms INTEGER,
                five_hour_window_minutes INTEGER,
                seven_day_remaining REAL,
                seven_day_reset_at_ms INTEGER,
                seven_day_window_minutes INTEGER,
                stale INTEGER NOT NULL DEFAULT 0,
                break_before INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL,
                granularity TEXT NOT NULL DEFAULT 'raw',
                updated_at_ms INTEGER NOT NULL
            )""",
            "CREATE INDEX IF NOT EXISTS quota_observations_range ON quota_observations(observed_at_ms)",
            "CREATE INDEX IF NOT EXISTS quota_observations_five_reset ON quota_observations(five_hour_reset_at_ms, observed_at_ms)",
            "CREATE INDEX IF NOT EXISTS quota_observations_seven_reset ON quota_observations(seven_day_reset_at_ms, observed_at_ms)",
        ]
        with self._lock, self._connection:
            for statement in statements:
                self._connection.execute(statement)

    def set_setting(self, key: str, value: Any) -> None:
        serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, serialized),
            )

    def get_setting(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return default

    def upsert_quota_observation(self, observation: dict[str, Any]) -> str:
        """Insert a normalized quota observation without rewriting history files."""

        observed_at_ms = int(observation["observed_at_ms"])
        now_ms = int(time.time() * 1000)
        values = (
            observed_at_ms,
            observation.get("five_hour_remaining"),
            observation.get("five_hour_reset_at_ms"),
            observation.get("five_hour_window_minutes"),
            observation.get("seven_day_remaining"),
            observation.get("seven_day_reset_at_ms"),
            observation.get("seven_day_window_minutes"),
            1 if observation.get("stale") else 0,
            1 if observation.get("break_before") else 0,
            str(observation.get("source") or "unknown")[:80],
            str(observation.get("granularity") or "raw")[:20],
            now_ms,
        )
        with self._lock, self._connection:
            existed = self._connection.execute(
                "SELECT 1 FROM quota_observations WHERE observed_at_ms = ?",
                (observed_at_ms,),
            ).fetchone()
            self._connection.execute(
                """INSERT INTO quota_observations(
                    observed_at_ms, five_hour_remaining, five_hour_reset_at_ms,
                    five_hour_window_minutes, seven_day_remaining,
                    seven_day_reset_at_ms, seven_day_window_minutes, stale,
                    break_before, source, granularity, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(observed_at_ms) DO UPDATE SET
                    five_hour_remaining = COALESCE(excluded.five_hour_remaining, quota_observations.five_hour_remaining),
                    five_hour_reset_at_ms = COALESCE(excluded.five_hour_reset_at_ms, quota_observations.five_hour_reset_at_ms),
                    five_hour_window_minutes = COALESCE(excluded.five_hour_window_minutes, quota_observations.five_hour_window_minutes),
                    seven_day_remaining = COALESCE(excluded.seven_day_remaining, quota_observations.seven_day_remaining),
                    seven_day_reset_at_ms = COALESCE(excluded.seven_day_reset_at_ms, quota_observations.seven_day_reset_at_ms),
                    seven_day_window_minutes = COALESCE(excluded.seven_day_window_minutes, quota_observations.seven_day_window_minutes),
                    stale = excluded.stale,
                    break_before = MAX(quota_observations.break_before, excluded.break_before),
                    source = excluded.source,
                    granularity = excluded.granularity,
                    updated_at_ms = excluded.updated_at_ms""",
                values,
            )
        return "updated" if existed is not None else "inserted"

    @staticmethod
    def _quota_observation_from_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            "observed_at_ms": int(row["observed_at_ms"]),
            "five_hour_remaining": (
                float(row["five_hour_remaining"])
                if row["five_hour_remaining"] is not None
                else None
            ),
            "five_hour_reset_at_ms": (
                int(row["five_hour_reset_at_ms"])
                if row["five_hour_reset_at_ms"] is not None
                else None
            ),
            "five_hour_window_minutes": (
                int(row["five_hour_window_minutes"])
                if row["five_hour_window_minutes"] is not None
                else None
            ),
            "seven_day_remaining": (
                float(row["seven_day_remaining"])
                if row["seven_day_remaining"] is not None
                else None
            ),
            "seven_day_reset_at_ms": (
                int(row["seven_day_reset_at_ms"])
                if row["seven_day_reset_at_ms"] is not None
                else None
            ),
            "seven_day_window_minutes": (
                int(row["seven_day_window_minutes"])
                if row["seven_day_window_minutes"] is not None
                else None
            ),
            "stale": bool(row["stale"]),
            "break_before": bool(row["break_before"]),
            "source": str(row["source"]),
            "granularity": str(row["granularity"]),
        }

    def latest_quota_observation(self, before_ms: int | None = None) -> dict[str, Any] | None:
        sql = "SELECT * FROM quota_observations"
        params: tuple[Any, ...] = ()
        if before_ms is not None:
            sql += " WHERE observed_at_ms < ?"
            params = (int(before_ms),)
        sql += " ORDER BY observed_at_ms DESC LIMIT 1"
        with self._lock:
            row = self._connection.execute(sql, params).fetchone()
        return self._quota_observation_from_row(row)

    def quota_observations_between(
        self, start_ms: int, end_ms: int
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """SELECT * FROM quota_observations
                WHERE observed_at_ms >= ? AND observed_at_ms <= ?
                ORDER BY observed_at_ms ASC""",
                (int(start_ms), int(end_ms)),
            ).fetchall()
        return [
            value
            for row in rows
            if (value := self._quota_observation_from_row(row)) is not None
        ]

    def delete_quota_observations(self, observed_at_values: Iterable[int]) -> int:
        rows = [(int(value),) for value in observed_at_values]
        if not rows:
            return 0
        with self._lock, self._connection:
            before = self._connection.total_changes
            self._connection.executemany(
                "DELETE FROM quota_observations WHERE observed_at_ms = ?", rows
            )
            return self._connection.total_changes - before

    def purge_quota_observations_before(self, cutoff_ms: int) -> int:
        with self._lock, self._connection:
            return self._connection.execute(
                "DELETE FROM quota_observations WHERE observed_at_ms < ?",
                (int(cutoff_ms),),
            ).rowcount

    def quota_observation_count(self) -> int:
        with self._lock:
            row = self._connection.execute(
                "SELECT COUNT(*) AS count FROM quota_observations"
            ).fetchone()
        return int(row["count"])

    def save_credentials(self, credentials: DeviceCredentials) -> None:
        payload = canonical_json(credentials.as_dict())
        protected = protect_secret(payload)
        credential_path = self.path.with_suffix(".credentials")
        temporary = credential_path.with_suffix(".credentials.tmp")
        temporary.write_bytes(protected)
        temporary.replace(credential_path)

    def load_credentials(self) -> DeviceCredentials | None:
        credential_path = self.path.with_suffix(".credentials")
        if not credential_path.exists():
            return None
        try:
            payload = unprotect_secret(credential_path.read_bytes())
            return DeviceCredentials.from_dict(json.loads(payload.decode("utf-8")))
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            return None

    def clear_credentials(self) -> None:
        self.path.with_suffix(".credentials").unlink(missing_ok=True)
        self.clear_pending_enrollment()

    def reset_pairing_data(self) -> None:
        auto_sync = self.get_setting("auto_sync", True)
        with self._lock, self._connection:
            for table in ("outgoing", "events", "active_intervals", "conflicts", "indexed_files", "settings"):
                self._connection.execute(f"DELETE FROM {table}")
        self.set_setting("auto_sync", bool(auto_sync))
        self.clear_credentials()

    def save_pending_enrollment(self, payload: dict[str, str]) -> None:
        protected = protect_secret(canonical_json(payload))
        pending_path = self.path.with_suffix(".enrollment")
        temporary = pending_path.with_suffix(".enrollment.tmp")
        temporary.write_bytes(protected)
        temporary.replace(pending_path)

    def load_pending_enrollment(self) -> dict[str, str] | None:
        pending_path = self.path.with_suffix(".enrollment")
        if not pending_path.exists():
            return None
        try:
            payload = json.loads(unprotect_secret(pending_path.read_bytes()).decode("utf-8"))
            required = {"endpoint", "space_id", "device_id", "private_key", "public_key"}
            if not isinstance(payload, dict) or not required.issubset(payload):
                return None
            return {key: str(payload[key]) for key in required}
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            return None

    def clear_pending_enrollment(self) -> None:
        self.path.with_suffix(".enrollment").unlink(missing_ok=True)

    def get_file_state(self, path: Path) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute("SELECT * FROM indexed_files WHERE path = ?", (str(path),)).fetchone()
        if row is None:
            return None
        return {
            "path": row["path"],
            "size": int(row["size"]),
            "mtime_ns": int(row["mtime_ns"]),
            "offset": int(row["offset"]),
            "state": json.loads(row["state_json"]),
        }

    def save_file_state(
        self,
        path: Path,
        *,
        size: int,
        mtime_ns: int,
        offset: int,
        state: dict[str, Any],
    ) -> None:
        now = int(time.time() * 1000)
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO indexed_files(path, size, mtime_ns, offset, state_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ns = excluded.mtime_ns,
                offset = excluded.offset, state_json = excluded.state_json, updated_at = excluded.updated_at""",
                (str(path), int(size), int(mtime_ns), int(offset), json.dumps(state, ensure_ascii=False), now),
            )

    def upsert_event(
        self,
        *,
        envelope: SyncEnvelope,
        payload: dict[str, Any],
        source_device_id: str,
        source_kind: str,
        queue: bool = False,
    ) -> str:
        if source_kind not in {"local", "remote"}:
            raise ValueError("source_kind must be local or remote")
        now = int(time.time() * 1000)
        payload_json = canonical_json(payload).decode("utf-8")
        envelope_json = canonical_json(envelope.as_dict()).decode("utf-8")
        with self._lock, self._connection:
            existing = self._connection.execute(
                "SELECT value_fingerprint FROM events WHERE event_fingerprint = ?",
                (envelope.event_fingerprint,),
            ).fetchone()
            if existing is not None and existing["value_fingerprint"] != envelope.value_fingerprint:
                self._connection.execute(
                    """INSERT INTO conflicts(event_fingerprint, value_fingerprint, source_device_id, first_seen_at, last_seen_at)
                    VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_fingerprint, value_fingerprint)
                    DO UPDATE SET last_seen_at = excluded.last_seen_at""",
                    (envelope.event_fingerprint, envelope.value_fingerprint, source_device_id, now, now),
                )
                return "conflict"
            if existing is not None:
                return "duplicate"
            self._connection.execute(
                """INSERT INTO events(event_fingerprint, value_fingerprint, source_device_id, source_kind,
                event_at, schema_version, payload_json, envelope_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    envelope.event_fingerprint,
                    envelope.value_fingerprint,
                    source_device_id,
                    source_kind,
                    envelope.event_at,
                    envelope.schema_version,
                    payload_json,
                    envelope_json,
                    now,
                ),
            )
            if queue:
                self._connection.execute(
                    "INSERT OR REPLACE INTO outgoing(event_fingerprint, envelope_json, queued_at, attempts, last_error) VALUES (?, ?, ?, 0, NULL)",
                    (envelope.event_fingerprint, envelope_json, now),
                )
        return "inserted"

    def pending_outgoing(self, limit: int = 200) -> list[SyncEnvelope]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT envelope_json FROM outgoing ORDER BY queued_at ASC LIMIT ?",
                (max(1, min(500, int(limit))),),
            ).fetchall()
        return [SyncEnvelope.from_dict(json.loads(row["envelope_json"])) for row in rows]

    def acknowledge_outgoing(self, fingerprints: Iterable[str]) -> None:
        values = [(str(value),) for value in fingerprints]
        if not values:
            return
        with self._lock, self._connection:
            self._connection.executemany("DELETE FROM outgoing WHERE event_fingerprint = ?", values)

    def mark_outgoing_failure(self, fingerprints: Iterable[str], error: str) -> None:
        values = [(str(error)[:500], str(value)) for value in fingerprints]
        if not values:
            return
        with self._lock, self._connection:
            self._connection.executemany(
                "UPDATE outgoing SET attempts = attempts + 1, last_error = ? WHERE event_fingerprint = ?",
                values,
            )

    def outgoing_count(self) -> int:
        with self._lock:
            row = self._connection.execute("SELECT COUNT(*) AS count FROM outgoing").fetchone()
        return int(row["count"])

    def events_between(self, start_ms: int, end_ms: int, source_kind: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM events WHERE event_at >= ? AND event_at <= ?"
        params: list[Any] = [int(start_ms), int(end_ms)]
        if source_kind is not None:
            sql += " AND source_kind = ?"
            params.append(source_kind)
        sql += " ORDER BY event_at ASC"
        with self._lock:
            rows = self._connection.execute(sql, params).fetchall()
        return [
            {
                "event_fingerprint": row["event_fingerprint"],
                "value_fingerprint": row["value_fingerprint"],
                "source_device_id": row["source_device_id"],
                "source_kind": row["source_kind"],
                "event_at": int(row["event_at"]),
                "schema_version": int(row["schema_version"]),
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    def replace_intervals(
        self,
        *,
        source_kind: str,
        source_device_id: str,
        intervals: Iterable[tuple[str, int, int]],
    ) -> None:
        if source_kind not in {"local", "remote"}:
            raise ValueError("source_kind must be local or remote")
        now = int(time.time() * 1000)
        rows = [
            (source_kind, source_device_id, str(key), int(start), int(end), now)
            for key, start, end in intervals
            if int(end) > int(start)
        ]
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM active_intervals WHERE source_kind = ? AND source_device_id = ?",
                (source_kind, source_device_id),
            )
            self._connection.executemany(
                "INSERT INTO active_intervals(source_kind, source_device_id, interval_key, start_ms, end_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )

    def upsert_intervals(
        self,
        *,
        source_kind: str,
        source_device_id: str,
        intervals: Iterable[tuple[str, int, int]],
    ) -> None:
        if source_kind not in {"local", "remote"}:
            raise ValueError("source_kind must be local or remote")
        now = int(time.time() * 1000)
        rows = [
            (source_kind, source_device_id, str(key), int(start), int(end), now)
            for key, start, end in intervals
            if int(end) > int(start)
        ]
        if not rows:
            return
        with self._lock, self._connection:
            self._connection.executemany(
                """INSERT INTO active_intervals(source_kind, source_device_id, interval_key, start_ms, end_ms, updated_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_kind, source_device_id, interval_key)
                DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, updated_at = excluded.updated_at""",
                rows,
            )

    def intervals_between(self, start_ms: int, end_ms: int, source_kind: str | None = None) -> list[tuple[int, int]]:
        sql = "SELECT start_ms, end_ms FROM active_intervals WHERE end_ms > ? AND start_ms < ?"
        params: list[Any] = [int(start_ms), int(end_ms)]
        if source_kind is not None:
            sql += " AND source_kind = ?"
            params.append(source_kind)
        with self._lock:
            rows = self._connection.execute(sql, params).fetchall()
        return [(int(row["start_ms"]), int(row["end_ms"])) for row in rows]

    def purge_before(self, cutoff_ms: int) -> dict[str, int]:
        with self._lock, self._connection:
            events = self._connection.execute("DELETE FROM events WHERE event_at < ?", (int(cutoff_ms),)).rowcount
            intervals = self._connection.execute("DELETE FROM active_intervals WHERE end_ms < ?", (int(cutoff_ms),)).rowcount
            stale_outgoing = self._connection.execute(
                "DELETE FROM outgoing WHERE event_fingerprint NOT IN (SELECT event_fingerprint FROM events)"
            ).rowcount
        return {"events": events, "intervals": intervals, "outgoing": stale_outgoing}

    def purge_incompatible_events(
        self, *, engine_version: int, pricing_version: str
    ) -> int:
        with self._lock:
            rows = self._connection.execute(
                "SELECT event_fingerprint, payload_json FROM events"
            ).fetchall()
        stale: list[tuple[str]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, json.JSONDecodeError):
                stale.append((str(row["event_fingerprint"]),))
                continue
            if (
                int(payload.get("engine_version", -1)) != int(engine_version)
                or str(payload.get("pricing_version") or "") != pricing_version
            ):
                stale.append((str(row["event_fingerprint"]),))
        if not stale:
            return 0
        with self._lock, self._connection:
            self._connection.executemany(
                "DELETE FROM outgoing WHERE event_fingerprint = ?", stale
            )
            self._connection.executemany(
                "DELETE FROM events WHERE event_fingerprint = ?", stale
            )
        return len(stale)
