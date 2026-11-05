from __future__ import annotations

import importlib.util
import http.client
import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from dashboard_sync.quota_history import QuotaHistory
from dashboard_sync.store import SyncStore


ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc


def load_dashboard():
    spec = importlib.util.spec_from_file_location(
        "token_dashboard_quota_history_backend",
        ROOT / "codex_token_speed_dashboard.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cycle(
    observed: datetime,
    *,
    remaining: float,
    reset: datetime,
    minutes: int,
) -> dict[str, object]:
    return {
        "observed_at": observed.isoformat(),
        "used_percent": 100 - remaining,
        "reset": reset.isoformat(),
        "window_minutes": minutes,
    }


def cycles(
    observed: datetime,
    *,
    five_remaining: float = 80,
    seven_remaining: float = 70,
    five_reset: datetime | None = None,
    seven_reset: datetime | None = None,
) -> dict[str, object]:
    return {
        "five_hour": cycle(
            observed,
            remaining=five_remaining,
            reset=five_reset or observed + timedelta(hours=4),
            minutes=300,
        ),
        "weekly": cycle(
            observed,
            remaining=seven_remaining,
            reset=seven_reset or observed + timedelta(days=5),
            minutes=10080,
        ),
    }


def test_store_migrates_dedicated_quota_table_and_indexes(tmp_path: Path) -> None:
    path = tmp_path / "sync.db"
    store = SyncStore(path)
    store.close()
    connection = sqlite3.connect(path)
    try:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(quota_observations)")
        }
        indexes = {
            row[1] for row in connection.execute("PRAGMA index_list(quota_observations)")
        }
    finally:
        connection.close()
    assert {
        "observed_at_ms",
        "five_hour_remaining",
        "seven_day_remaining",
        "stale",
        "break_before",
        "source",
    }.issubset(columns)
    assert "quota_observations_range" in indexes


def test_recent_changes_are_kept_and_unchanged_values_use_15_minute_heartbeat(
    tmp_path: Path,
) -> None:
    start = datetime(2026, 7, 13, 0, 0, tzinfo=UTC)
    five_reset = start + timedelta(hours=4)
    seven_reset = start + timedelta(days=5)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: start + timedelta(minutes=30))
    assert history.record_cycles(
        cycles(start, five_reset=five_reset, seven_reset=seven_reset),
        observed_at=start,
        stale=False,
    )
    assert not history.record_cycles(
        cycles(
            start + timedelta(minutes=5),
            five_reset=five_reset,
            seven_reset=seven_reset,
        ),
        observed_at=start + timedelta(minutes=5),
        stale=False,
    )
    assert history.record_cycles(
        cycles(
            start + timedelta(minutes=15),
            five_reset=five_reset,
            seven_reset=seven_reset,
        ),
        observed_at=start + timedelta(minutes=15),
        stale=False,
    )
    assert history.record_cycles(
        cycles(
            start + timedelta(minutes=16),
            five_remaining=79,
            five_reset=five_reset,
            seven_reset=seven_reset,
        ),
        observed_at=start + timedelta(minutes=16),
        stale=False,
    )
    assert store.quota_observation_count() == 3
    store.close()


def test_cycle_specific_breaks_do_not_disconnect_the_other_curve(tmp_path: Path) -> None:
    start = datetime(2026, 7, 13, 0, 0, tzinfo=UTC)
    five_a = start + timedelta(hours=4)
    five_b = start + timedelta(hours=9)
    seven = start + timedelta(days=5)
    observed_a = start + timedelta(hours=3, minutes=45)
    observed_b = start + timedelta(hours=3, minutes=59)
    observed_c = start + timedelta(hours=4, minutes=1)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: observed_c)
    history.record_cycles(
        cycles(observed_a, five_reset=five_a, seven_reset=seven),
        observed_at=observed_a,
        stale=False,
    )
    history.record_cycles(
        cycles(
            observed_b,
            five_reset=five_a,
            seven_reset=seven,
        ),
        observed_at=observed_b,
        stale=False,
    )
    history.record_cycles(
        cycles(
            observed_c,
            five_reset=five_b,
            seven_reset=seven,
        ),
        observed_at=observed_c,
        stale=False,
    )
    # Compatibility with an early pre-release row where any reset was stored
    # as the global break flag.
    store.upsert_quota_observation(
        {
            "observed_at_ms": int(observed_c.timestamp() * 1000),
            "break_before": True,
            "source": "legacy-test",
        }
    )
    samples = history.query(7, now=observed_c)
    assert samples[-1]["break_before"] is False
    assert samples[-1]["five_hour_break_before"] is True
    assert samples[-1]["seven_day_break_before"] is False
    store.close()


def test_reset_jitter_within_30_seconds_is_same_identity(tmp_path: Path) -> None:
    start = datetime(2026, 7, 13, 0, 0, tzinfo=UTC)
    five_reset = start + timedelta(hours=4)
    seven_reset = start + timedelta(days=5)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: start + timedelta(minutes=15))
    history.record_cycles(
        cycles(start, five_reset=five_reset, seven_reset=seven_reset),
        observed_at=start,
        stale=False,
    )
    assert not history.record_cycles(
        cycles(
            start + timedelta(minutes=5),
            five_reset=five_reset + timedelta(seconds=1),
            seven_reset=seven_reset + timedelta(seconds=1),
        ),
        observed_at=start + timedelta(minutes=5),
        stale=False,
    )
    history.record_cycles(
        cycles(
            start + timedelta(minutes=15),
            five_reset=five_reset + timedelta(seconds=16),
            seven_reset=seven_reset + timedelta(seconds=16),
        ),
        observed_at=start + timedelta(minutes=15),
        stale=False,
    )
    samples = history.query(7, now=start + timedelta(minutes=15))
    assert len(samples) == 2
    assert samples[-1]["five_hour_break_before"] is False
    assert samples[-1]["seven_day_break_before"] is False
    store.close()


def test_limit_keeps_reset_anchors_even_when_it_exceeds_target(tmp_path: Path) -> None:
    start = datetime(2026, 7, 13, 0, 0, tzinfo=UTC)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: start + timedelta(minutes=20))
    seven_reset = start + timedelta(days=5)
    for index in range(3):
        observed = start + timedelta(minutes=index * 5)
        history.record_cycles(
            cycles(
                observed,
                five_remaining=80 - index,
                five_reset=start + timedelta(hours=4, minutes=index * 5),
                seven_reset=seven_reset,
            ),
            observed_at=observed,
            stale=False,
        )
    samples = history.query(7, max_points=2, now=start + timedelta(minutes=20))
    assert len(samples) == 3
    assert all(sample["five_hour_break_before"] for sample in samples)
    assert samples[1]["seven_day_break_before"] is False
    store.close()


def test_led_history_import_maps_windows_by_duration_and_marks_once(
    tmp_path: Path,
) -> None:
    now = datetime(2026, 7, 13, 8, 0, tzinfo=UTC)
    path = tmp_path / "quota-history.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "samples": [
                    {
                        "fetchedAt": (now - timedelta(minutes=20)).isoformat(),
                        "primary": {
                            "remainingPercent": 81,
                            "windowDurationMins": 300,
                            "resetsAt": (now + timedelta(hours=4)).isoformat(),
                        },
                        "secondary": {
                            "remainingPercent": 62,
                            "windowDurationMins": 10080,
                            "resetsAt": (now + timedelta(days=5)).isoformat(),
                        },
                    },
                    {
                        "fetchedAt": (now - timedelta(minutes=5)).isoformat(),
                        "primary": {
                            "remainingPercent": 61,
                            "windowDurationMins": 10080,
                            "resetsAt": (now + timedelta(days=5)).isoformat(),
                        },
                        "secondary": None,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: now)
    first = history.import_led_history_once(path, now=now)
    second = history.import_led_history_once(path, now=now)
    samples = history.query(7, now=now)
    assert first["inserted"] == 2
    assert second == {"completed": True, "skipped": True, "inserted": 0}
    assert samples[0]["five_hour_remaining"] == 81
    assert samples[0]["seven_day_remaining"] == 62
    assert samples[1]["five_hour_remaining"] is None
    assert samples[1]["seven_day_remaining"] == 61
    store.close()


def test_compaction_keeps_first_last_and_extrema_and_purges_older_than_180_days(
    tmp_path: Path,
) -> None:
    now = datetime(2026, 7, 13, 8, 0, tzinfo=UTC)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: now)
    values = [50, 80, 20, 60, 70, 40]
    for age_days in (20, 70):
        base = now - timedelta(days=age_days)
        for index, value in enumerate(values):
            observed = base + timedelta(minutes=index)
            store.upsert_quota_observation(
                {
                    "observed_at_ms": int(observed.timestamp() * 1000),
                    "five_hour_remaining": value,
                    "five_hour_reset_at_ms": int((base + timedelta(hours=4)).timestamp() * 1000),
                    "five_hour_window_minutes": 300,
                    "seven_day_remaining": 100 - value,
                    "seven_day_reset_at_ms": int((base + timedelta(days=5)).timestamp() * 1000),
                    "seven_day_window_minutes": 10080,
                    "stale": False,
                    "break_before": False,
                    "source": "test",
                    "granularity": "raw",
                }
            )
    expired = now - timedelta(days=181)
    store.upsert_quota_observation(
        {
            "observed_at_ms": int(expired.timestamp() * 1000),
            "five_hour_remaining": 50,
            "source": "test",
        }
    )
    result = history.compact(now)
    rows = store.quota_observations_between(
        int((now - timedelta(days=180)).timestamp() * 1000),
        int(now.timestamp() * 1000),
    )
    assert result["expired"] == 1
    assert result["compacted"] == 4
    assert len(rows) == 8
    for age_days in (20, 70):
        base_ms = int((now - timedelta(days=age_days)).timestamp() * 1000)
        kept_offsets = {
            (int(row["observed_at_ms"]) - base_ms) // 60_000
            for row in rows
            if base_ms <= int(row["observed_at_ms"]) < base_ms + 10 * 60_000
        }
        assert kept_offsets == {0, 1, 2, 5}
    store.close()


def test_widget_payload_has_total_cost_only_and_canonical_cycle_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dashboard = load_dashboard()
    now = datetime(2026, 7, 13, 8, 0, tzinfo=UTC)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: now)
    fake_stats = {
        "cycles": cycles(now),
        "summary": {
            "cost_base": 1.25,
            "cost_max": 1.5,
            "cost_complete": False,
        },
        "range": {
            "label": "5h周期",
            "start": (now - timedelta(hours=1)).isoformat(),
            "end": now.isoformat(),
        },
        "data_complete": True,
    }
    monkeypatch.setattr(dashboard, "make_stats", lambda *_args, **_kwargs: fake_stats)
    server = SimpleNamespace(
        sessions_roots=[tmp_path],
        sessions_root=tmp_path,
        scan_hours=8,
        quota_history=history,
    )
    payload = dashboard.make_widget_payload(server, "cycle_5h", now)
    assert payload["version"] == 1
    assert set(payload["cycles"]) == {"five_hour", "seven_day"}
    assert payload["usage"] == {
        "range": "cycle_5h",
        "label": "5h周期",
        "start": (now - timedelta(hours=1)).isoformat(),
        "end": now.isoformat(),
        "cost_base": 1.25,
        "cost_max": 1.5,
        "cost_complete": False,
        "data_complete": True,
    }
    assert not any("rate" in key for key in payload["usage"])
    assert payload["quota_status"]["state"] == "normal"
    store.close()


def test_widget_quota_status_uses_fresh_7d_when_5h_is_missing() -> None:
    dashboard = load_dashboard()
    now = datetime(2026, 7, 13, 8, 0, tzinfo=UTC)
    status = dashboard.build_widget_quota_status(
        {
            "remaining_percent": None,
            "reset_at": None,
            "window_minutes": None,
            "stale": True,
        },
        {
            "remaining_percent": 62,
            "reset_at": (now + timedelta(days=5)).isoformat(),
            "window_minutes": 10080,
            "stale": False,
        },
        now,
    )
    assert status["state"] not in {"unavailable", "stale"}


def test_quota_history_payload_contract_and_validation(tmp_path: Path) -> None:
    dashboard = load_dashboard()
    now = datetime(2026, 7, 13, 8, 0, tzinfo=UTC)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: now)
    history.record_cycles(cycles(now), observed_at=now, stale=False)
    server = SimpleNamespace(quota_history=history)
    payload = dashboard.make_quota_history_payload(server, 7, 100, now)
    assert payload["version"] == 1
    assert payload["days"] == 7
    assert set(payload["samples"][0]) == {
        "observed_at",
        "five_hour_remaining",
        "five_hour_reset_at",
        "seven_day_remaining",
        "seven_day_reset_at",
        "seven_day_ideal_remaining",
        "stale",
        "break_before",
        "five_hour_break_before",
        "seven_day_break_before",
    }
    exact = dashboard.make_quota_history_payload(
        server,
        None,
        100,
        now,
        start=now - timedelta(hours=3),
        end=now,
    )
    assert exact["days"] is None
    assert exact["start"] == (now - timedelta(hours=3)).isoformat()
    assert exact["end"] == now.isoformat()
    with pytest.raises(dashboard.StatsRequestError) as invalid_days:
        dashboard.make_quota_history_payload(server, 8, 100, now)
    assert invalid_days.value.code == "invalid_days"
    store.close()


def test_http_routes_expose_widget_and_quota_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dashboard = load_dashboard()
    now = datetime(2026, 7, 13, 8, 0, tzinfo=UTC)
    store = SyncStore(tmp_path / "sync.db")
    history = QuotaHistory(store, clock=lambda: now)
    history.record_cycles(cycles(now), observed_at=now, stale=False)
    fake_stats = {
        "cycles": cycles(now),
        "summary": {
            "cost_base": 2.0,
            "cost_max": 2.0,
            "cost_complete": True,
        },
        "range": {
            "label": "5h周期",
            "start": (now - timedelta(hours=1)).isoformat(),
            "end": now.isoformat(),
        },
        "data_complete": True,
    }
    monkeypatch.setattr(dashboard, "make_stats", lambda *_args, **_kwargs: fake_stats)
    monkeypatch.setattr(dashboard, "local_now", lambda: now)

    class QuietHandler(dashboard.DashboardHandler):
        def log_message(self, _fmt: str, *_args) -> None:
            return None

    server = dashboard.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    server.sessions_roots = [tmp_path]
    server.sessions_root = tmp_path
    server.scan_hours = 8
    server.quota_history = history
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_port, timeout=5
        )
        connection.request("GET", "/api/widget?usage_range=cycle_5h")
        response = connection.getresponse()
        widget = json.loads(response.read().decode("utf-8"))
        connection.close()
        assert response.status == 200
        assert widget["usage"]["cost_base"] == 2.0

        connection = http.client.HTTPConnection(
            "127.0.0.1", server.server_port, timeout=5
        )
        connection.request("GET", "/api/quota-history?days=7&max_points=100")
        response = connection.getresponse()
        quota = json.loads(response.read().decode("utf-8"))
        connection.close()
        assert response.status == 200
        assert quota["samples"][0]["seven_day_ideal_remaining"] is not None
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        store.close()
