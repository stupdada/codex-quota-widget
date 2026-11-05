from __future__ import annotations

from collections.abc import Iterable

Interval = tuple[int, int]


def union_intervals(
    intervals: Iterable[Interval],
    *,
    clip_start: int | None = None,
    clip_end: int | None = None,
) -> list[Interval]:
    normalized: list[Interval] = []
    for raw_start, raw_end in intervals:
        start = int(raw_start)
        end = int(raw_end)
        if clip_start is not None:
            start = max(start, int(clip_start))
        if clip_end is not None:
            end = min(end, int(clip_end))
        if end > start:
            normalized.append((start, end))
    normalized.sort()
    merged: list[Interval] = []
    for start, end in normalized:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
            continue
        previous_start, previous_end = merged[-1]
        merged[-1] = (previous_start, max(previous_end, end))
    return merged


def active_duration_ms(
    intervals: Iterable[Interval],
    *,
    clip_start: int | None = None,
    clip_end: int | None = None,
) -> int:
    return sum(
        end - start
        for start, end in union_intervals(
            intervals,
            clip_start=clip_start,
            clip_end=clip_end,
        )
    )


def format_active_duration(duration_ms: int) -> str:
    duration_ms = max(0, int(duration_ms))
    if duration_ms < 60_000:
        return "少于一分钟"
    minutes = int(round(duration_ms / 60_000))
    hours, remaining = divmod(minutes, 60)
    if not hours:
        return f"{remaining}分钟"
    if not remaining:
        return f"{hours}小时"
    return f"{hours}小时{remaining}分"
