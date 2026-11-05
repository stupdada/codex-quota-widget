from __future__ import annotations

import json
from pathlib import Path

from quota_reset_exit import QuotaResetExitController, reset_detected


def cycle(reset: str, used: float) -> dict:
    return {
        "cycle_name": "weekly",
        "reset": reset,
        "used_percent": used,
        "source": "app-server-direct",
    }


class Reader:
    def __init__(self, values: list[dict[str, dict | None]]) -> None:
        self.values = values
        self.calls = 0

    def __call__(self) -> dict[str, dict | None]:
        index = min(self.calls, len(self.values) - 1)
        self.calls += 1
        return self.values[index]


def test_reset_detection_accepts_window_jump_or_large_drop() -> None:
    baseline = cycle("2026-07-18T14:04:40+08:00", 54)
    assert reset_detected(baseline, cycle("2026-07-20T03:00:00+08:00", 1))
    assert reset_detected(baseline, cycle(baseline["reset"], 8))
    assert not reset_detected(baseline, cycle(baseline["reset"], 45))


def test_rolling_reset_timestamp_still_confirms_the_same_reset(tmp_path: Path) -> None:
    baseline = cycle("2026-07-18T14:04:40+08:00", 54)
    reader = Reader(
        [
            {"five_hour": None, "weekly": baseline},
            {"five_hour": None, "weekly": cycle("2026-07-20T02:58:20+08:00", 0)},
            {"five_hour": None, "weekly": cycle("2026-07-20T02:58:47+08:00", 0)},
        ]
    )
    closes: list[bool] = []
    controller = QuotaResetExitController(
        reader,
        lambda: closes.append(True) or {"success": True},
        state_path=tmp_path / "state.json",
        log_path=tmp_path / "events.jsonl",
        poll_seconds=1,
    )
    controller.arm("weekly")
    assert controller.poll_once()["confirmation_count"] == 1
    assert controller.poll_once()["phase"] == "completed"
    assert closes == [True]


def test_weekly_arm_requires_two_direct_confirmations_then_closes_once(tmp_path: Path) -> None:
    baseline = cycle("2026-07-18T14:04:40+08:00", 54)
    reset = cycle("2026-07-20T03:00:00+08:00", 1)
    reader = Reader(
        [
            {"five_hour": None, "weekly": baseline},
            {"five_hour": None, "weekly": baseline},
            {"five_hour": None, "weekly": reset},
            {"five_hour": None, "weekly": reset},
        ]
    )
    closes: list[dict] = []

    def close() -> dict:
        result = {"success": True, "target_pids": [123], "remaining_pids": []}
        closes.append(result)
        return result

    controller = QuotaResetExitController(
        reader,
        close,
        state_path=tmp_path / "state.json",
        log_path=tmp_path / "events.jsonl",
        poll_seconds=1,
    )

    armed = controller.arm("weekly")
    assert armed["armed"] is True
    assert armed["baseline"] == baseline
    controller.poll_once()
    first = controller.poll_once()
    assert first["confirmation_count"] == 1
    assert closes == []
    completed = controller.poll_once()

    assert completed["armed"] is False
    assert completed["phase"] == "completed"
    assert completed["close_result"]["success"] is True
    assert len(closes) == 1
    persisted = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert persisted["phase"] == "completed"
    events = (tmp_path / "events.jsonl").read_text(encoding="utf-8")
    assert '"event":"reset_confirmed"' in events
    assert '"event":"desktop_close_result"' in events


def test_failed_close_remains_armed_and_retries_without_new_quota_read(tmp_path: Path) -> None:
    baseline = cycle("2026-07-18T14:04:40+08:00", 54)
    reset = cycle("2026-07-20T03:00:00+08:00", 1)
    reader = Reader(
        [
            {"five_hour": None, "weekly": baseline},
            {"five_hour": None, "weekly": reset},
            {"five_hour": None, "weekly": reset},
        ]
    )
    attempts = [
        {"success": False, "error": "still running"},
        {"success": True, "target_pids": [123], "remaining_pids": []},
    ]

    controller = QuotaResetExitController(
        reader,
        lambda: attempts.pop(0),
        state_path=tmp_path / "state.json",
        log_path=tmp_path / "events.jsonl",
        poll_seconds=1,
    )
    controller.arm("weekly")
    controller.poll_once()
    retrying = controller.poll_once()
    assert retrying["armed"] is True
    assert retrying["phase"] == "retry_close"
    calls_before_retry = reader.calls
    completed = controller.poll_once()
    assert completed["phase"] == "completed"
    assert reader.calls == calls_before_retry


def test_unavailable_cycle_cannot_be_armed_and_cancel_is_persistent(tmp_path: Path) -> None:
    baseline = cycle("2026-07-18T14:04:40+08:00", 54)
    controller = QuotaResetExitController(
        lambda: {"five_hour": None, "weekly": baseline},
        lambda: {"success": True},
        state_path=tmp_path / "state.json",
        log_path=tmp_path / "events.jsonl",
    )
    try:
        controller.arm("five_hour")
    except ValueError as error:
        assert "5h" in str(error)
    else:
        raise AssertionError("unavailable 5h cycle was armed")

    controller.arm("weekly")
    cancelled = controller.cancel()
    assert cancelled["armed"] is False
    assert cancelled["phase"] == "cancelled"
