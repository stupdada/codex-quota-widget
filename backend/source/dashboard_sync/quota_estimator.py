from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timedelta
from collections.abc import Callable
from typing import Any, Iterable

CREDITS_PER_DOLLAR_EQUIVALENT = 25.0
DEFAULT_WEEKLY_MULTIPLIER = 6.0
MULTIPLIER_PRIOR_WEEKLY_POINTS = 3.0
MULTIPLIER_LOOKBACK = timedelta(days=14)
MULTIPLIER_HALF_LIFE = timedelta(days=3.5)
FIVE_HOUR_LOOKBACK = timedelta(hours=24)
FIVE_HOUR_HALF_LIFE = timedelta(hours=8)
WEEKLY_CURRENT_FULL_WEIGHT_PERCENT = 8.0
CURRENT_OBSERVATION_STALE_AFTER = timedelta(minutes=10)
OBSERVATION_SETTING = "quota_estimator_observations_v1"


def _parse_time(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _normalize_cycle(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    start = _parse_time(value.get("start"))
    reset = _parse_time(value.get("reset"))
    try:
        used_percent = float(value.get("used_percent"))
    except (TypeError, ValueError):
        return None
    if start is None or reset is None or reset <= start:
        return None
    return {
        "start": start.isoformat(),
        "reset": reset.isoformat(),
        "used_percent": max(0.0, min(100.0, used_percent)),
    }


def _normalize_observation(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    observed = _parse_time(value.get("observed_at"))
    if observed is None:
        return None
    five = _normalize_cycle(value.get("five_hour"))
    weekly = _normalize_cycle(value.get("weekly"))
    if five is None and weekly is None:
        return None
    return {
        "observed_at": observed.isoformat(),
        "five_hour": five,
        "weekly": weekly,
    }


def _current_cycle(value: object, now: datetime) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    start = _parse_time(value.get("start"))
    reset = _parse_time(value.get("reset"))
    observed = _parse_time(value.get("observed_at"))
    if start is None or reset is None or observed is None:
        return None
    if not (start <= now < reset):
        return None
    if observed > now + timedelta(minutes=5) or now - observed > CURRENT_OBSERVATION_STALE_AFTER:
        return None
    return value


def _cycle_signature(cycle: dict[str, Any] | None) -> tuple:
    if not cycle:
        return (None, None)
    return (cycle.get("reset"), round(float(cycle.get("used_percent", 0.0)), 4))


def merge_observations(
    existing: Iterable[dict[str, Any]],
    incoming: Iterable[dict[str, Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    cutoff = now - MULTIPLIER_LOOKBACK
    future_limit = now + timedelta(minutes=5)
    normalized: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for raw in [*existing, *incoming]:
        item = _normalize_observation(raw)
        if item is None:
            continue
        observed = _parse_time(item["observed_at"])
        if observed is None or observed < cutoff or observed > future_limit:
            continue
        key = (
            item["observed_at"],
            _cycle_signature(item.get("five_hour")),
            _cycle_signature(item.get("weekly")),
        )
        if key in seen:
            continue
        seen.add(key)
        normalized.append(item)
    normalized.sort(key=lambda item: item["observed_at"])

    compacted: list[dict[str, Any]] = []
    for item in normalized:
        signature = (
            _cycle_signature(item.get("five_hour")),
            _cycle_signature(item.get("weekly")),
        )
        if compacted:
            previous_signature = (
                _cycle_signature(compacted[-1].get("five_hour")),
                _cycle_signature(compacted[-1].get("weekly")),
            )
            if signature == previous_signature:
                compacted[-1] = item
                continue
        compacted.append(item)
    return compacted


def _recency_weight(age: timedelta, half_life: timedelta) -> float:
    seconds = max(0.0, age.total_seconds())
    return 0.5 ** (seconds / half_life.total_seconds())


def calculate_dynamic_multiplier(
    observations: Iterable[dict[str, Any]],
    now: datetime,
) -> dict[str, Any]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in merge_observations([], observations, now):
        five = item.get("five_hour")
        weekly = item.get("weekly")
        if not isinstance(five, dict) or not isinstance(weekly, dict):
            continue
        groups[(str(five["reset"]), str(weekly["reset"]))].append(item)

    numerator = DEFAULT_WEEKLY_MULTIPLIER * MULTIPLIER_PRIOR_WEEKLY_POINTS
    denominator = MULTIPLIER_PRIOR_WEEKLY_POINTS
    weekly_delta = 0.0
    sample_groups = 0
    sample_times: list[datetime] = []
    for items in groups.values():
        items.sort(key=lambda item: item["observed_at"])
        first, last = items[0], items[-1]
        if first is last:
            continue
        delta_five = float(last["five_hour"]["used_percent"]) - float(
            first["five_hour"]["used_percent"]
        )
        delta_weekly = float(last["weekly"]["used_percent"]) - float(
            first["weekly"]["used_percent"]
        )
        observed = _parse_time(last["observed_at"])
        if delta_five <= 0 or delta_weekly <= 0 or observed is None:
            continue
        weight = _recency_weight(now - observed, MULTIPLIER_HALF_LIFE)
        numerator += weight * delta_five
        denominator += weight * delta_weekly
        weekly_delta += delta_weekly
        sample_groups += 1
        sample_times.extend(
            time
            for time in (
                _parse_time(first["observed_at"]),
                observed,
            )
            if time is not None
        )

    value = numerator / denominator if denominator > 0 else DEFAULT_WEEKLY_MULTIPLIER
    sample_days = 0.0
    if sample_times:
        sample_days = max(0.0, (max(sample_times) - min(sample_times)).total_seconds() / 86400)
    return {
        "value": value,
        "source": "learned" if sample_groups else "prior",
        "weekly_delta_percent": weekly_delta,
        "sample_groups": sample_groups,
        "sample_days": sample_days,
        "prior": DEFAULT_WEEKLY_MULTIPLIER,
        "prior_weekly_points": MULTIPLIER_PRIOR_WEEKLY_POINTS,
    }


def _weighted_median(samples: list[dict[str, Any]]) -> float | None:
    usable = [
        sample
        for sample in samples
        if math.isfinite(float(sample.get("value", 0.0)))
        and float(sample.get("value", 0.0)) > 0
        and float(sample.get("weight", 0.0)) > 0
    ]
    if not usable:
        return None
    usable.sort(key=lambda sample: float(sample["value"]))
    threshold = sum(float(sample["weight"]) for sample in usable) / 2
    running = 0.0
    for sample in usable:
        running += float(sample["weight"])
        if running >= threshold:
            return float(sample["value"])
    return float(usable[-1]["value"])


class QuotaEstimator:
    def __init__(
        self,
        store: Any,
        usage_between: Callable[[datetime, datetime], dict[str, Any]] | None = None,
    ) -> None:
        self.store = store
        self.usage_between = usage_between

    def observations(self) -> list[dict[str, Any]]:
        value = self.store.get_setting(OBSERVATION_SETTING, [])
        return list(value) if isinstance(value, list) else []

    def add_observations(
        self, observations: Iterable[dict[str, Any]], now: datetime
    ) -> list[dict[str, Any]]:
        merged = merge_observations(self.observations(), observations, now)
        self.store.set_setting(OBSERVATION_SETTING, merged)
        return merged

    def observe(self, cycles: dict[str, Any], now: datetime) -> None:
        if not isinstance(cycles, dict):
            return
        five_hour = _current_cycle(cycles.get("five_hour"), now)
        weekly = _current_cycle(cycles.get("weekly"), now)
        if five_hour is None and weekly is None:
            return
        observed_times = [
            value
            for value in (
                _parse_time(cycle.get("observed_at"))
                for cycle in (five_hour, weekly)
                if isinstance(cycle, dict)
            )
            if value is not None
        ]
        observed_at = max(observed_times) if observed_times else now
        self.add_observations(
            [
                {
                    "observed_at": observed_at.isoformat(),
                    "five_hour": five_hour,
                    "weekly": weekly,
                }
            ],
            now,
        )

    def _usage_between(self, start: datetime, end: datetime) -> dict[str, Any]:
        result = {
            "usd": 0.0,
            "tokens": 0,
            "event_count": 0,
            "complete": True,
        }
        if self.usage_between is None:
            return result
        provided = self.usage_between(start, end)
        if not isinstance(provided, dict):
            return result
        result["usd"] = max(0.0, float(provided.get("usd", 0.0) or 0.0))
        result["tokens"] = max(0, int(provided.get("tokens", 0) or 0))
        result["event_count"] = max(0, int(provided.get("event_count", 0) or 0))
        result["complete"] = bool(provided.get("complete", True))
        return result

    def _capacity_samples(
        self,
        observations: list[dict[str, Any]],
        cycle_name: str,
        now: datetime,
        lookback: timedelta,
        half_life: timedelta,
        minimum_delta: float,
    ) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        cutoff = now - lookback
        for item in observations:
            observed = _parse_time(item.get("observed_at"))
            cycle = item.get(cycle_name)
            if observed is None or observed < cutoff or not isinstance(cycle, dict):
                continue
            groups[str(cycle.get("reset"))].append(item)

        samples: list[dict[str, Any]] = []
        for reset, items in groups.items():
            items.sort(key=lambda item: item["observed_at"])
            first, last = items[0], items[-1]
            first_cycle = first[cycle_name]
            last_cycle = last[cycle_name]
            delta_percent = float(last_cycle["used_percent"]) - float(
                first_cycle["used_percent"]
            )
            first_time = _parse_time(first["observed_at"])
            last_time = _parse_time(last["observed_at"])
            if (
                delta_percent < minimum_delta
                or first_time is None
                or last_time is None
                or last_time <= first_time
            ):
                continue
            usage = self._usage_between(first_time, last_time)
            if usage["event_count"] <= 0 or usage["usd"] <= 0:
                continue
            samples.append(
                {
                    "reset": reset,
                    "value": usage["usd"] / (delta_percent / 100.0),
                    "delta_percent": delta_percent,
                    "observed_at": last_time,
                    "weight": _recency_weight(now - last_time, half_life),
                    "complete": usage["complete"],
                    "event_count": usage["event_count"],
                    "tokens": usage["tokens"],
                    "usd": usage["usd"],
                }
            )
        return samples

    def estimate(self, cycles: dict[str, Any], now: datetime) -> dict[str, Any]:
        observations = merge_observations([], self.observations(), now)
        multiplier = calculate_dynamic_multiplier(observations, now)
        multiplier_value = float(multiplier["value"])
        five_samples = self._capacity_samples(
            observations,
            "five_hour",
            now,
            FIVE_HOUR_LOOKBACK,
            FIVE_HOUR_HALF_LIFE,
            2.0,
        )
        weekly_samples = self._capacity_samples(
            observations,
            "weekly",
            now,
            MULTIPLIER_LOOKBACK,
            MULTIPLIER_HALF_LIFE,
            1.0,
        )
        current_five = (
            _current_cycle(cycles.get("five_hour"), now)
            if isinstance(cycles, dict)
            else None
        )
        current_weekly = (
            _current_cycle(cycles.get("weekly"), now)
            if isinstance(cycles, dict)
            else None
        )
        current_weekly_reset = (
            str(current_weekly.get("reset")) if isinstance(current_weekly, dict) else None
        )
        current_weekly_samples = [
            sample
            for sample in weekly_samples
            if current_weekly_reset and sample["reset"] == current_weekly_reset
        ]
        historical_weekly_samples = [
            sample
            for sample in weekly_samples
            if not current_weekly_reset or sample["reset"] != current_weekly_reset
        ]
        five_base = _weighted_median(five_samples)
        weekly_history = _weighted_median(historical_weekly_samples)
        weekly_current = _weighted_median(current_weekly_samples)
        weekly_delta = max(
            (float(sample["delta_percent"]) for sample in current_weekly_samples),
            default=0.0,
        )
        weekly_weight = min(1.0, weekly_delta / WEEKLY_CURRENT_FULL_WEIGHT_PERCENT)

        weekly_base = five_base * multiplier_value if five_base is not None else weekly_history
        weekly_value: float | None = None
        five_value: float | None = None
        source = "unavailable"
        if isinstance(current_five, dict) and five_base is not None:
            five_value = five_base
            weekly_value = five_base * multiplier_value
            source = "current_five_hour"
            weekly_weight = 0.0
        elif weekly_current is not None:
            if weekly_base is None:
                weekly_value = weekly_current
                source = "current_weekly"
            else:
                weekly_value = weekly_base * (1.0 - weekly_weight) + weekly_current * weekly_weight
                source = "current_weekly_blend"
            five_value = weekly_value / multiplier_value
        elif weekly_base is not None:
            weekly_value = weekly_base
            five_value = weekly_value / multiplier_value
            source = "historical"

        available = bool(
            weekly_value is not None
            and five_value is not None
            and math.isfinite(weekly_value)
            and math.isfinite(five_value)
        )
        if not available:
            weekly_value = None
            five_value = None
        confidence = "low"
        if source == "current_five_hour" and len(five_samples) >= 2:
            confidence = "high"
        elif weekly_weight >= 1.0:
            confidence = "high"
        elif weekly_weight >= 0.5 or source == "current_five_hour":
            confidence = "medium"

        all_samples = five_samples + weekly_samples
        return {
            "available": available,
            "stale": False,
            "complete": all(bool(sample.get("complete", True)) for sample in all_samples),
            "credits": 0.0,
            "tokens": sum(int(sample.get("tokens", 0)) for sample in all_samples),
            "consumed_usd_equivalent": sum(float(sample.get("usd", 0.0)) for sample in all_samples),
            "five_hour_usd_equivalent": five_value,
            "weekly_usd_equivalent": weekly_value,
            "weekly_multiplier": multiplier_value,
            "multiplier_source": multiplier["source"],
            "multiplier_weekly_delta_percent": multiplier["weekly_delta_percent"],
            "multiplier_sample_groups": multiplier["sample_groups"],
            "multiplier_sample_days": multiplier["sample_days"],
            "weekly_current_weight": weekly_weight,
            "weekly_current_delta_percent": weekly_delta,
            "estimate_source": source,
            "confidence": confidence,
            "history_window_hours": int(FIVE_HOUR_LOOKBACK.total_seconds() / 3600),
            "multiplier_lookback_days": int(MULTIPLIER_LOOKBACK.total_seconds() / 86400),
            "credits_per_dollar": CREDITS_PER_DOLLAR_EQUIVALENT,
            "remote_included": False,
            "event_count": sum(int(sample.get("event_count", 0)) for sample in all_samples),
            "reason": "ok" if available else "history_unavailable",
        }
