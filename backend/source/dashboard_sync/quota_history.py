from __future__ import annotations

import json
import math
import os
import threading
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

from .store import SyncStore


FIVE_HOUR_WINDOW_MINUTES = 5 * 60
SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60
FINE_RETENTION = timedelta(days=14)
QUARTER_HOUR_RETENTION = timedelta(days=60)
MAX_RETENTION = timedelta(days=180)
UNCHANGED_HEARTBEAT = timedelta(minutes=15)
RECENT_GAP = timedelta(minutes=45)
OLD_GAP = timedelta(hours=3)
RESET_IDENTITY_TOLERANCE_MS = 30_000
LED_IMPORT_MARKER = "quota_history_led_import_v1"
SESSION_BACKFILL_MARKER = "quota_history_session_backfill_v1"


def _parse_time(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value or "").strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone()


def _as_epoch_ms(value: object) -> int | None:
    parsed = _parse_time(value)
    return int(parsed.timestamp() * 1000) if parsed is not None else None


def _iso_from_ms(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000).astimezone().isoformat()


def _valid_percent(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0 or number > 100:
        return None
    return round(number, 4)


def _valid_positive_int(value: object) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _cycle_values(
    cycle: object,
    observed_at_ms: int,
    fallback_window_minutes: int,
) -> tuple[float | None, int | None, int | None]:
    if not isinstance(cycle, dict):
        return None, None, None
    remaining = _valid_percent(cycle.get("remaining_percent"))
    if remaining is None:
        used = _valid_percent(cycle.get("used_percent"))
        remaining = round(100.0 - used, 4) if used is not None else None
    reset_ms = _as_epoch_ms(cycle.get("reset") or cycle.get("reset_at"))
    window_minutes = (
        _valid_positive_int(cycle.get("window_minutes"))
        or _valid_positive_int(cycle.get("windowDurationMins"))
        or fallback_window_minutes
    )
    # A reset point from a different/expired cycle is an anomaly, not a point
    # that should be connected to the current curve.
    if reset_ms is not None:
        earliest = reset_ms - (window_minutes * 60_000) - 15 * 60_000
        if observed_at_ms < earliest or observed_at_ms >= reset_ms + 60_000:
            return None, None, window_minutes
    return remaining, reset_ms, window_minutes


def _led_window_values(
    value: object, observed_at_ms: int
) -> tuple[int | None, tuple[float | None, int | None, int | None]]:
    if not isinstance(value, dict):
        return None, (None, None, None)
    duration = _valid_positive_int(value.get("windowDurationMins"))
    if duration is None:
        return None, (None, None, None)
    cycle = {
        "remaining_percent": value.get("remainingPercent"),
        "reset_at": value.get("resetsAt"),
        "window_minutes": duration,
    }
    return duration, _cycle_values(cycle, observed_at_ms, duration)


def _same_state(first: dict[str, Any], second: dict[str, Any]) -> bool:
    keys = (
        "five_hour_remaining",
        "five_hour_window_minutes",
        "seven_day_remaining",
        "seven_day_window_minutes",
        "stale",
    )
    return all(first.get(key) == second.get(key) for key in keys) and not any(
        _reset_identity_changed(first.get(key), second.get(key))
        for key in ("five_hour_reset_at_ms", "seven_day_reset_at_ms")
    )


def _reset_identity_changed(first: object, second: object) -> bool:
    if first is None and second is None:
        return False
    if first is None or second is None:
        return True
    try:
        return abs(int(first) - int(second)) > RESET_IDENTITY_TOLERANCE_MS
    except (TypeError, ValueError):
        return True


def _reset_changed(first: dict[str, Any], second: dict[str, Any]) -> bool:
    for key in ("five_hour_reset_at_ms", "seven_day_reset_at_ms"):
        if _reset_identity_changed(first.get(key), second.get(key)):
            return True
    return False


def _representative_ids(
    rows: list[dict[str, Any]], bucket_ms: int
) -> set[int]:
    buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[int(row["observed_at_ms"]) // bucket_ms].append(row)
    selected: set[int] = set()
    for bucket in buckets.values():
        bucket.sort(key=lambda item: int(item["observed_at_ms"]))
        selected.add(int(bucket[0]["observed_at_ms"]))
        selected.add(int(bucket[-1]["observed_at_ms"]))
        for key in ("five_hour_remaining", "seven_day_remaining"):
            available = [row for row in bucket if row.get(key) is not None]
            if not available:
                continue
            selected.add(int(min(available, key=lambda item: float(item[key]))["observed_at_ms"]))
            selected.add(int(max(available, key=lambda item: float(item[key]))["observed_at_ms"]))
    return selected


def _evenly_spaced_ids(rows: list[dict[str, Any]], count: int) -> set[int]:
    if count <= 0 or not rows:
        return set()
    if len(rows) <= count:
        return {int(row["observed_at_ms"]) for row in rows}
    if count == 1:
        return {int(rows[len(rows) // 2]["observed_at_ms"])}
    indexes = {
        round(index * (len(rows) - 1) / (count - 1)) for index in range(count)
    }
    return {int(rows[index]["observed_at_ms"]) for index in indexes}


class QuotaHistory:
    """SQLite-backed quota history shared by the dashboard and compact widget."""

    def __init__(
        self,
        store: SyncStore,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.store = store
        self.clock = clock or (lambda: datetime.now().astimezone())
        self._lock = threading.RLock()
        self._last_compact_at: datetime | None = None

    def _record(self, record: dict[str, Any], *, heartbeat: bool = True) -> bool:
        with self._lock:
            observed_at_ms = int(record["observed_at_ms"])
            previous = self.store.latest_quota_observation(observed_at_ms + 1)
            if previous is not None and int(previous["observed_at_ms"]) == observed_at_ms:
                self.store.upsert_quota_observation(record)
                return True
            if previous is not None:
                elapsed = observed_at_ms - int(previous["observed_at_ms"])
                if heartbeat and elapsed >= 0 and elapsed < int(UNCHANGED_HEARTBEAT.total_seconds() * 1000):
                    if _same_state(previous, record):
                        return False
                if elapsed > int(RECENT_GAP.total_seconds() * 1000):
                    record["break_before"] = True
            self.store.upsert_quota_observation(record)
            return True

    def record_cycles(
        self,
        cycles: object,
        *,
        observed_at: datetime | str | None = None,
        source: str = "dashboard",
        stale: bool | None = None,
    ) -> bool:
        if not isinstance(cycles, dict):
            return False
        five = cycles.get("five_hour")
        seven = cycles.get("weekly") or cycles.get("seven_day")
        observed = _parse_time(observed_at)
        if observed is None:
            observed_candidates = []
            for cycle in (five, seven):
                if isinstance(cycle, dict):
                    parsed = _parse_time(cycle.get("observed_at"))
                    if parsed is not None:
                        observed_candidates.append(parsed)
            observed = max(observed_candidates) if observed_candidates else self.clock()
        observed_at_ms = int(observed.timestamp() * 1000)
        five_values = _cycle_values(five, observed_at_ms, FIVE_HOUR_WINDOW_MINUTES)
        seven_values = _cycle_values(seven, observed_at_ms, SEVEN_DAY_WINDOW_MINUTES)
        missing_all = five_values[0] is None and seven_values[0] is None
        now = self.clock()
        inferred_stale = now - observed > timedelta(minutes=10)
        for reset_ms in (five_values[1], seven_values[1]):
            if reset_ms is not None and int(now.timestamp() * 1000) >= reset_ms:
                inferred_stale = True
        record = {
            "observed_at_ms": observed_at_ms,
            "five_hour_remaining": five_values[0],
            "five_hour_reset_at_ms": five_values[1],
            "five_hour_window_minutes": five_values[2],
            "seven_day_remaining": seven_values[0],
            "seven_day_reset_at_ms": seven_values[1],
            "seven_day_window_minutes": seven_values[2],
            "stale": True if missing_all else (inferred_stale if stale is None else bool(stale)),
            "break_before": missing_all,
            "source": source,
            "granularity": "raw",
        }
        return self._record(record)

    def add_observations(
        self, observations: Iterable[dict[str, Any]], *, source: str
    ) -> int:
        sortable: list[tuple[datetime, dict[str, Any]]] = []
        for observation in observations:
            observed = _parse_time(observation.get("observed_at"))
            if observed is not None:
                sortable.append((observed, observation))
        inserted = 0
        for observed, observation in sorted(sortable, key=lambda item: item[0]):
            if self.record_cycles(
                observation,
                observed_at=observed,
                source=source,
                stale=False,
            ):
                inserted += 1
        return inserted

    def backfill_sessions_once(
        self, observations: Iterable[dict[str, Any]], *, now: datetime | None = None
    ) -> dict[str, Any]:
        marker = self.store.get_setting(SESSION_BACKFILL_MARKER)
        if isinstance(marker, dict) and marker.get("completed"):
            return {"completed": True, "skipped": True, "inserted": 0}
        effective_now = now or self.clock()
        inserted = self.add_observations(observations, source="session-backfill")
        result = {
            "completed": True,
            "skipped": False,
            "inserted": inserted,
            "completed_at": effective_now.isoformat(),
        }
        self.store.set_setting(SESSION_BACKFILL_MARKER, result)
        self.compact(effective_now)
        return result

    def import_led_history_once(
        self,
        path: Path | None = None,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        marker = self.store.get_setting(LED_IMPORT_MARKER)
        if isinstance(marker, dict) and marker.get("completed"):
            return {"completed": True, "skipped": True, "inserted": 0}
        if path is None:
            roaming = os.environ.get("APPDATA")
            base = Path(roaming) if roaming else Path.home() / "AppData" / "Roaming"
            path = base / "codex-quota-widget" / "quota-history.json"
        if not path.is_file():
            return {"completed": False, "skipped": True, "inserted": 0, "reason": "missing"}
        if path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("LED quota history is unexpectedly large")
        payload = json.loads(path.read_text(encoding="utf-8"))
        samples = payload.get("samples") if isinstance(payload, dict) else None
        if not isinstance(samples, list):
            raise ValueError("LED quota history has no samples array")
        normalized: list[dict[str, Any]] = []
        for sample in samples:
            if not isinstance(sample, dict):
                continue
            observed = _parse_time(sample.get("fetchedAt"))
            if observed is None:
                continue
            observed_at_ms = int(observed.timestamp() * 1000)
            five_values = (None, None, None)
            seven_values = (None, None, None)
            for key in ("primary", "secondary"):
                duration, values = _led_window_values(sample.get(key), observed_at_ms)
                if duration == FIVE_HOUR_WINDOW_MINUTES:
                    five_values = values
                elif duration == SEVEN_DAY_WINDOW_MINUTES:
                    seven_values = values
            if five_values[0] is None and seven_values[0] is None:
                continue
            normalized.append(
                {
                    "observed_at_ms": observed_at_ms,
                    "five_hour_remaining": five_values[0],
                    "five_hour_reset_at_ms": five_values[1],
                    "five_hour_window_minutes": five_values[2],
                    "seven_day_remaining": seven_values[0],
                    "seven_day_reset_at_ms": seven_values[1],
                    "seven_day_window_minutes": seven_values[2],
                    "stale": False,
                    "break_before": False,
                    "source": "led-import",
                    "granularity": "raw",
                }
            )
        inserted = 0
        for record in sorted(normalized, key=lambda item: int(item["observed_at_ms"])):
            if self._record(record):
                inserted += 1
        effective_now = now or self.clock()
        result = {
            "completed": True,
            "skipped": False,
            "inserted": inserted,
            "source_samples": len(samples),
            "path": str(path),
            "completed_at": effective_now.isoformat(),
        }
        self.store.set_setting(LED_IMPORT_MARKER, result)
        self.compact(effective_now)
        return result

    def compact(self, now: datetime | None = None) -> dict[str, int]:
        with self._lock:
            effective_now = now or self.clock()
            now_ms = int(effective_now.timestamp() * 1000)
            retention_start = now_ms - int(MAX_RETENTION.total_seconds() * 1000)
            deleted_expired = self.store.purge_quota_observations_before(retention_start)
            rows = self.store.quota_observations_between(retention_start, now_ms + 5 * 60_000)
            fine_cutoff = now_ms - int(FINE_RETENTION.total_seconds() * 1000)
            quarter_cutoff = now_ms - int(QUARTER_HOUR_RETENTION.total_seconds() * 1000)
            quarter_rows = [
                row for row in rows if quarter_cutoff <= int(row["observed_at_ms"]) < fine_cutoff
            ]
            hourly_rows = [row for row in rows if int(row["observed_at_ms"]) < quarter_cutoff]
            keep = {
                int(row["observed_at_ms"])
                for row in rows
                if int(row["observed_at_ms"]) >= fine_cutoff
            }
            keep.update(_representative_ids(quarter_rows, 15 * 60_000))
            keep.update(_representative_ids(hourly_rows, 60 * 60_000))

            previous: dict[str, Any] | None = None
            for row in rows:
                if previous is not None:
                    gap = int(row["observed_at_ms"]) - int(previous["observed_at_ms"])
                    age = now_ms - int(row["observed_at_ms"])
                    gap_limit = OLD_GAP if age > int(QUARTER_HOUR_RETENTION.total_seconds() * 1000) else RECENT_GAP
                    if gap > int(gap_limit.total_seconds() * 1000) or _reset_changed(previous, row):
                        keep.add(int(previous["observed_at_ms"]))
                        keep.add(int(row["observed_at_ms"]))
                if row.get("break_before"):
                    keep.add(int(row["observed_at_ms"]))
                previous = row
            removable = [
                int(row["observed_at_ms"])
                for row in rows
                if int(row["observed_at_ms"]) < fine_cutoff
                and int(row["observed_at_ms"]) not in keep
            ]
            deleted_compacted = self.store.delete_quota_observations(removable)
            self._last_compact_at = effective_now
            return {"expired": deleted_expired, "compacted": deleted_compacted}

    def maintain(self, now: datetime | None = None) -> None:
        effective_now = now or self.clock()
        if (
            self._last_compact_at is None
            or effective_now - self._last_compact_at >= timedelta(hours=1)
        ):
            self.compact(effective_now)

    def _with_breaks(
        self, rows: list[dict[str, Any]], now: datetime
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        now_ms = int(now.timestamp() * 1000)
        previous: dict[str, Any] | None = None
        quarter_cutoff = now_ms - int(QUARTER_HOUR_RETENTION.total_seconds() * 1000)
        for original in rows:
            row = dict(original)
            # Derive discontinuities from facts on read. This also keeps early
            # pre-release rows (where break_before included any reset) from
            # disconnecting the unrelated quota curve.
            missing_all = (
                row.get("five_hour_remaining") is None
                and row.get("seven_day_remaining") is None
            )
            global_break = previous is None or missing_all
            five_hour_break = global_break
            seven_day_break = global_break
            if previous is not None:
                gap = int(row["observed_at_ms"]) - int(previous["observed_at_ms"])
                gap_limit = OLD_GAP if int(row["observed_at_ms"]) < quarter_cutoff else RECENT_GAP
                gap_break = gap > int(gap_limit.total_seconds() * 1000)
                global_break = global_break or gap_break
                five_hour_break = global_break or (
                    _reset_identity_changed(
                        previous.get("five_hour_reset_at_ms"),
                        row.get("five_hour_reset_at_ms"),
                    )
                    or previous.get("five_hour_remaining") is None
                    or row.get("five_hour_remaining") is None
                )
                seven_day_break = global_break or (
                    _reset_identity_changed(
                        previous.get("seven_day_reset_at_ms"),
                        row.get("seven_day_reset_at_ms"),
                    )
                    or previous.get("seven_day_remaining") is None
                    or row.get("seven_day_remaining") is None
                )
            row["break_before"] = global_break
            row["five_hour_break_before"] = five_hour_break
            row["seven_day_break_before"] = seven_day_break
            result.append(row)
            previous = original
        return result

    def _limit_rows(
        self, rows: list[dict[str, Any]], max_points: int
    ) -> list[dict[str, Any]]:
        if len(rows) <= max_points:
            return rows
        mandatory_ids: set[int] = set()
        for index, row in enumerate(rows):
            if (
                row.get("break_before")
                or row.get("five_hour_break_before")
                or row.get("seven_day_break_before")
            ):
                mandatory_ids.add(int(row["observed_at_ms"]))
                if index > 0:
                    mandatory_ids.add(int(rows[index - 1]["observed_at_ms"]))
        mandatory_ids.update(
            {int(rows[0]["observed_at_ms"]), int(rows[-1]["observed_at_ms"])}
        )
        for key in ("five_hour_remaining", "seven_day_remaining"):
            available = [row for row in rows if row.get(key) is not None]
            if available:
                mandatory_ids.add(int(min(available, key=lambda item: float(item[key]))["observed_at_ms"]))
                mandatory_ids.add(int(max(available, key=lambda item: float(item[key]))["observed_at_ms"]))
        mandatory = [row for row in rows if int(row["observed_at_ms"]) in mandatory_ids]
        if len(mandatory) >= max_points:
            # Reset and gap anchors are semantically meaningful. max_points is
            # a target, not permission to reconnect unrelated cycles.
            selected_ids = mandatory_ids
        else:
            optional = [row for row in rows if int(row["observed_at_ms"]) not in mandatory_ids]
            selected_ids = mandatory_ids | _evenly_spaced_ids(optional, max_points - len(mandatory))
        return [row for row in rows if int(row["observed_at_ms"]) in selected_ids]

    def query(
        self,
        days: int,
        *,
        max_points: int = 3000,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        effective_now = now or self.clock()
        return self.query_range(
            effective_now - timedelta(days=days),
            effective_now,
            max_points=max_points,
        )

    def query_range(
        self,
        start: datetime,
        end: datetime,
        *,
        max_points: int = 3000,
    ) -> list[dict[str, Any]]:
        rows = self.store.quota_observations_between(
            int(start.timestamp() * 1000), int(end.timestamp() * 1000)
        )
        rows = self._with_breaks(rows, end)
        rows = self._limit_rows(rows, max(2, int(max_points)))
        samples: list[dict[str, Any]] = []
        for row in rows:
            observed_ms = int(row["observed_at_ms"])
            reset_ms = row.get("seven_day_reset_at_ms")
            window_minutes = row.get("seven_day_window_minutes") or SEVEN_DAY_WINDOW_MINUTES
            ideal: float | None = None
            if reset_ms is not None and window_minutes:
                remaining_ms = int(reset_ms) - observed_ms
                window_ms = int(window_minutes) * 60_000
                if 0 <= remaining_ms <= window_ms + 15 * 60_000:
                    ideal = round(max(0.0, min(100.0, remaining_ms / window_ms * 100.0)), 4)
            samples.append(
                {
                    "observed_at": _iso_from_ms(observed_ms),
                    "five_hour_remaining": row.get("five_hour_remaining"),
                    "five_hour_reset_at": _iso_from_ms(row.get("five_hour_reset_at_ms")),
                    "seven_day_remaining": row.get("seven_day_remaining"),
                    "seven_day_reset_at": _iso_from_ms(reset_ms),
                    "seven_day_ideal_remaining": ideal,
                    "stale": bool(row.get("stale")),
                    "break_before": bool(row.get("break_before")),
                    "five_hour_break_before": bool(
                        row.get("five_hour_break_before")
                    ),
                    "seven_day_break_before": bool(
                        row.get("seven_day_break_before")
                    ),
                }
            )
        return samples
