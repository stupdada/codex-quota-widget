from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path

import codex_token_speed_dashboard as dashboard
from session_index import PersistentSessionIndex


def _token_row(timestamp: str, cumulative: int, request: int) -> dict:
    return {
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": cumulative,
                    "output_tokens": 0,
                    "total_tokens": cumulative,
                },
                "last_token_usage": {
                    "input_tokens": request,
                    "output_tokens": 0,
                    "total_tokens": request,
                },
            },
        },
    }


def _write_session(path: Path, thread_id: str, amount: int) -> None:
    rows = [
        {
            "timestamp": "2026-07-23T00:00:00Z",
            "type": "session_meta",
            "payload": {"id": thread_id, "cwd": "C:\\demo"},
        },
        {
            "timestamp": "2026-07-23T00:00:01Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.6-sol"},
        },
        _token_row("2026-07-23T00:00:02Z", amount, amount),
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def test_scanner_reuses_unchanged_files_and_reparses_only_changed_file(
    tmp_path: Path, monkeypatch
) -> None:
    index = PersistentSessionIndex(tmp_path / "session-index.sqlite3")
    monkeypatch.setattr(dashboard, "persistent_session_index", lambda: index)
    root = tmp_path / "sessions"
    first_id = "019f0000-0000-7000-8000-000000000101"
    second_id = "019f0000-0000-7000-8000-000000000102"
    first = root / f"rollout-2026-07-23T08-00-00-{first_id}.jsonl"
    second = root / f"rollout-2026-07-23T08-00-00-{second_id}.jsonl"
    _write_session(first, first_id, 100)
    _write_session(second, second_id, 200)
    start = datetime.fromisoformat("2026-07-23T00:00:00+08:00")
    end = start + timedelta(hours=10)

    dashboard.SCAN_RESULT_CACHE.clear()
    cold = dashboard.SessionScanner(root, 8)
    assert len(cold.load_sessions(start, end)) == 2
    assert cold.scan_counts["cache_misses"] == 2

    dashboard.SCAN_RESULT_CACHE.clear()
    warm = dashboard.SessionScanner(root, 8)
    assert len(warm.load_sessions(start, end)) == 2
    assert warm.scan_counts["cache_hits"] == 2
    assert warm.scan_counts["cache_misses"] == 0

    with first.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(_token_row("2026-07-23T00:00:03Z", 150, 50)) + "\n")
    dashboard.SCAN_RESULT_CACHE.clear()
    changed = dashboard.SessionScanner(root, 8)
    sessions = changed.load_sessions(start, end)
    assert changed.scan_counts["cache_hits"] == 1
    assert changed.scan_counts["cache_misses"] == 1
    totals = {
        session["thread_id"]: dashboard.range_delta(session, start, end)["total"]
        for session in sessions
    }
    assert totals[first_id] == 150
    assert totals[second_id] == 200
    index.close()


def test_scanner_streams_large_session_by_default(
    tmp_path: Path, monkeypatch
) -> None:
    index = PersistentSessionIndex(tmp_path / "session-index.sqlite3")
    monkeypatch.setattr(dashboard, "persistent_session_index", lambda: index)
    root = tmp_path / "sessions"
    thread_id = "019f0000-0000-7000-8000-000000000103"
    path = root / f"rollout-2026-07-23T08-00-00-{thread_id}.jsonl"
    _write_session(path, thread_id, 300)

    target = os.path.normcase(os.path.abspath(path))
    real_stat = Path.stat

    class ReportedLargeSize:
        def __init__(self, result) -> None:
            self._result = result
            self.st_size = 300 * 1024 * 1024

        def __getattr__(self, name):
            return getattr(self._result, name)

    def report_large_session_size(self: Path, *args, **kwargs):
        result = real_stat(self, *args, **kwargs)
        if os.path.normcase(os.path.abspath(self)) != target:
            return result
        return ReportedLargeSize(result)

    monkeypatch.setattr(Path, "stat", report_large_session_size)
    start = datetime.fromisoformat("2026-07-23T00:00:00+08:00")
    end = start + timedelta(hours=10)

    dashboard.SCAN_RESULT_CACHE.clear()
    scanner = dashboard.SessionScanner(root, 8)
    sessions = scanner.load_sessions(start, end)

    assert len(sessions) == 1
    assert scanner.scan_counts["oversize_skipped"] == 0
    assert dashboard.range_delta(sessions[0], start, end)["total"] == 300
    index.close()
