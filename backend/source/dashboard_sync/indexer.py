from __future__ import annotations

import hashlib
import json
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable

from .crypto import encrypt_event, unb64u
from .protocol import ENGINE_VERSION, PRICING_VERSION, SCHEMA_VERSION, canonical_json
from .store import SyncStore


class IncrementalSessionIndexer:
    """Tail local Codex JSONL files and persist only anonymous usage/activity facts."""

    def __init__(
        self,
        sessions_root: Path,
        store: SyncStore,
        credentials: Callable[[], Any],
        *,
        queue_events: bool = True,
    ) -> None:
        self.sessions_root = Path(sessions_root)
        self.store = store
        self.credentials = credentials
        self.queue_events = bool(queue_events)

    def scan_once(self) -> int:
        credentials = self.credentials()
        if not credentials or not credentials.data_key:
            return 0

        import codex_token_speed_dashboard as dashboard

        now = dashboard.local_now()
        start = now - timedelta(days=7)
        scanner = dashboard.SessionScanner(self.sessions_root, 24 * 7)
        paths = scanner.candidate_paths(start, now)
        inserted = 0
        for path in paths:
            inserted += self._scan_path(path, credentials, dashboard)
        cutoff_ms = int((time.time() - 7 * 24 * 3600) * 1000)
        self.store.purge_before(cutoff_ms)
        return inserted

    def _scan_path(self, path: Path, credentials: Any, dashboard: Any) -> int:
        try:
            stat = path.stat()
        except OSError:
            return 0
        previous = self.store.get_file_state(path) or {}
        offset = int(previous.get("offset", 0) or 0)
        state = dict(previous.get("state") or {})
        if (
            int(state.get("engine_version", -1)) != ENGINE_VERSION
            or str(state.get("pricing_version") or "") != PRICING_VERSION
        ):
            offset = 0
            state = {
                "engine_version": ENGINE_VERSION,
                "pricing_version": PRICING_VERSION,
            }
        if stat.st_size < offset:
            offset = 0
            state = {}
        if stat.st_size == offset and int(previous.get("mtime_ns", 0) or 0) == stat.st_mtime_ns:
            return 0

        data_key = unb64u(credentials.data_key)
        inserted = 0
        complete_offset = offset
        try:
            with path.open("rb") as handle:
                handle.seek(offset)
                while True:
                    raw = handle.readline()
                    if not raw:
                        break
                    if not raw.endswith(b"\n"):
                        break
                    complete_offset = handle.tell()
                    try:
                        obj = json.loads(raw.decode("utf-8", errors="ignore"))
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        continue
                    inserted += self._consume(obj, path, state, credentials, data_key, dashboard)
        except OSError:
            return 0

        inserted += self._emit_open_activity(path, state, credentials, data_key)
        self.store.save_file_state(
            path,
            size=stat.st_size,
            mtime_ns=stat.st_mtime_ns,
            offset=complete_offset,
            state=state,
        )
        return inserted

    def _consume(
        self,
        obj: dict[str, Any],
        path: Path,
        state: dict[str, Any],
        credentials: Any,
        data_key: bytes,
        dashboard: Any,
    ) -> int:
        timestamp = dashboard.parse_timestamp(obj.get("timestamp"))
        timestamp_ms = int(timestamp.timestamp() * 1000) if timestamp else None
        payload = obj.get("payload") or {}
        obj_type = str(obj.get("type") or "")

        if obj_type == "session_meta":
            model = dashboard.extract_model(payload)
            if model:
                state["model"] = model
        elif obj_type == "turn_context":
            model = dashboard.extract_model(payload)
            if model:
                state["model"] = model
            if timestamp_ms is not None and not state.get("turn_start_ms"):
                state["turn_start_ms"] = timestamp_ms
                state["last_activity_ms"] = timestamp_ms
        elif obj_type == "event_msg" and payload.get("type") == "thread_settings_applied":
            model = dashboard.extract_model(payload)
            tier = dashboard.extract_service_tier(payload)
            if model:
                state["model"] = model
            if tier:
                state["service_tier"] = tier

        if timestamp_ms is not None and self._is_agent_activity(obj_type, payload):
            if not state.get("turn_start_ms"):
                state["turn_start_ms"] = timestamp_ms
            state["last_activity_ms"] = timestamp_ms

        inserted = 0
        if dashboard.is_token_event(obj) and timestamp_ms is not None:
            usage = dashboard.extract_last_usage(payload)
            if usage and int(usage.get("total", 0)) > 0:
                model = str(state.get("model") or dashboard.extract_model(payload) or "(unknown)")
                service_tier = str(state.get("service_tier") or "default")
                info = payload.get("info") if isinstance(payload, dict) else None
                raw_request = (
                    info.get("last_token_usage") if isinstance(info, dict) else None
                )
                cache_write_known = dashboard.usage_has_field(
                    raw_request,
                    ["cache_write_tokens", "cache_creation_input_tokens"],
                )
                cost = dashboard.price_usage(
                    usage,
                    model,
                    request_input=int(usage.get("input", 0)),
                    cache_write_known=cache_write_known,
                    service_tier=service_tier,
                )
                anonymous = {
                    "kind": "usage",
                    "event_at": timestamp_ms,
                    "schema_version": SCHEMA_VERSION,
                    "engine_version": ENGINE_VERSION,
                    "pricing_version": PRICING_VERSION,
                    "usage": usage,
                    "cost": cost,
                    "activity": [],
                }
                source_id = "usage:" + hashlib.sha256(
                    canonical_json(
                        {
                            "timestamp": timestamp_ms,
                            "usage": usage,
                            "model": model,
                            "service_tier": service_tier,
                            "engine_version": ENGINE_VERSION,
                            "pricing_version": PRICING_VERSION,
                        }
                    )
                ).hexdigest()
                envelope = encrypt_event(
                    data_key,
                    space_id=credentials.space_id,
                    source_event_id=source_id,
                    payload=anonymous,
                )
                result = self.store.upsert_event(
                    envelope=envelope,
                    payload=anonymous,
                    source_device_id=credentials.device_id,
                    source_kind="local",
                    queue=self.queue_events,
                )
                inserted += int(result == "inserted")

        if obj_type == "event_msg" and payload.get("type") == "task_complete":
            inserted += self._emit_open_activity(path, state, credentials, data_key, closed=True)
        return inserted

    @staticmethod
    def _is_agent_activity(obj_type: str, payload: dict[str, Any]) -> bool:
        if obj_type == "turn_context":
            return True
        if obj_type == "response_item":
            return str(payload.get("role") or "") != "user"
        if obj_type == "event_msg":
            return str(payload.get("type") or "") not in {"user_message", "user_input"}
        return False

    def _emit_open_activity(
        self,
        path: Path,
        state: dict[str, Any],
        credentials: Any,
        data_key: bytes,
        *,
        closed: bool = False,
    ) -> int:
        start_ms = int(state.get("turn_start_ms", 0) or 0)
        end_ms = int(state.get("last_activity_ms", 0) or 0)
        if end_ms <= start_ms:
            if closed:
                state.pop("turn_start_ms", None)
                state.pop("last_activity_ms", None)
            return 0
        local_key = hashlib.sha256(f"{path}:{start_ms}".encode("utf-8")).hexdigest()
        self.store.upsert_intervals(
            source_kind="local",
            source_device_id=credentials.device_id,
            intervals=[(local_key, start_ms, end_ms)],
        )
        last_emitted = int(state.get("last_emitted_activity_end_ms", 0) or 0)
        inserted = 0
        if end_ms > last_emitted:
            anonymous = {
                "kind": "activity",
                "event_at": end_ms,
                "schema_version": SCHEMA_VERSION,
                "engine_version": ENGINE_VERSION,
                "pricing_version": PRICING_VERSION,
                "usage": {},
                "cost": {},
                "activity": [[start_ms, end_ms]],
            }
            source_id = (
                f"activity:{start_ms}:{end_ms}:{ENGINE_VERSION}:{PRICING_VERSION}"
            )
            envelope = encrypt_event(
                data_key,
                space_id=credentials.space_id,
                source_event_id=source_id,
                payload=anonymous,
            )
            result = self.store.upsert_event(
                envelope=envelope,
                payload=anonymous,
                source_device_id=credentials.device_id,
                source_kind="local",
                queue=self.queue_events,
            )
            inserted = int(result == "inserted")
            state["last_emitted_activity_end_ms"] = end_ms
        if closed:
            state.pop("turn_start_ms", None)
            state.pop("last_activity_ms", None)
            state.pop("last_emitted_activity_end_ms", None)
        return inserted
