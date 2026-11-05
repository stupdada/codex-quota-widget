from __future__ import annotations

import json
import time
from datetime import datetime

import pytest

import codex_token_speed_dashboard as dashboard


@pytest.mark.parametrize(
    "model,base,maximum,credits",
    [
        ("gpt-6.1-sol", 0.296, 0.316, 7.4),
        ("gpt-6-sol", 0.312, 0.332, 7.8),
        ("gpt-6-astra", 1.56, 1.66, 39.0),
        ("gpt-5.6-sol", 0.624, 0.664, 15.6),
        ("gpt-5.6-terra", 0.352, 0.372, 8.8),
        ("gpt-5.6-luna", 0.0352, 0.0372, 0.88),
    ],
)
def test_current_rates_with_cached_input_and_fast_credits(model, base, maximum, credits):
    usage = {"input": 200_000, "cached": 160_000, "output": 20_000, "total": 220_000}
    ordinary = dashboard.price_usage(usage, model)
    assert ordinary["cost_base"] == pytest.approx(base)
    assert ordinary["cost_max"] == pytest.approx(maximum)
    assert ordinary["credits"] == pytest.approx(credits)
    assert ordinary["complete"] and ordinary["credits_complete"]
    assert ordinary["unpriced_models"] == []
    assert ordinary["pricing_precision"] == "bounded"

    fast = dashboard.price_usage(usage, model, service_tier="fast")
    assert fast["credits"] == pytest.approx(credits * 2.0)
    assert fast["credits_complete"] is True
    # API-equivalent comparisons use the dashboard's ordinary-rate basis.
    assert fast["cost_base"] == pytest.approx(base)
    assert dashboard.price_usage(usage, model, service_tier="priority") == ordinary


def test_astra_known_cache_writes_and_large_context_use_regular_rates():
    usage = {"input": 300_000, "cached": 250_000, "cache_write": 4_000,
             "output": 10_000, "total": 310_000}
    priced = dashboard.price_usage(usage, " GPT-6-ASTRA ",
                                   request_input=300_000, cache_write_known=True)
    # 50K ordinary input + 250K cache reads + 10K output + 4K write surcharge.
    assert priced["cost_base"] == pytest.approx(1.26)
    assert priced["cost_max"] == pytest.approx(1.26)
    assert priced["credits"] == pytest.approx(31.25)
    assert priced["pricing_precision"] == "exact"
    assert priced["models_used"] == ["gpt-6-astra"]


@pytest.mark.parametrize("model,cost,credits", [
    ("gpt-6-astra", 1.56, 39.0),
    ("gpt-6.1-sol", 0.296, 7.4),
    ("gpt-6-sol", 0.312, 7.8),
])
def test_supported_session_reaches_stats(tmp_path, model, cost, credits):
    session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    rows = [
        {"timestamp": "2026-09-05T01:00:00Z", "type": "session_meta",
         "payload": {"id": session_id, "cwd": "D:/demo"}},
        {"timestamp": "2026-09-05T01:00:00Z", "type": "turn_context",
         "payload": {"model": model, "service_tier": "priority"}},
        {"timestamp": "2026-09-05T01:01:00Z", "type": "event_msg",
         "payload": {"type": "token_count", "info": {"last_token_usage": {
             "input_tokens": 200_000, "cached_input_tokens": 160_000,
             "output_tokens": 20_000, "total_tokens": 220_000}}}},
    ]
    (tmp_path / f"rollout-2026-09-05T09-00-00-{session_id}.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    start = datetime.fromisoformat("2026-09-05T09:00:00+08:00")
    end = datetime.fromisoformat("2026-09-05T09:10:00+08:00")
    sessions = dashboard.SessionScanner(tmp_path, 8).load_sessions(start, end)
    stats = dashboard.summarize(sessions, start, end)
    summary = stats["summary"]
    assert summary["total"] == 220_000
    assert summary["cost_base"] == pytest.approx(cost)
    assert summary["credits"] == pytest.approx(credits)
    assert summary["credits_complete"] is True
    assert summary["unpriced_models"] == []
    assert summary["models_used"] == [model]
    assert any(p["id"] == model for p in dashboard.pricing_profiles_for_api())


def test_previous_price_cache_is_not_reused(tmp_path):
    path = tmp_path / "stats.json"
    payload = {"version": 3, "entries": [
        {"key": "today", "saved_at": time.time(), "stats": {"summary": {"credits": 22}}}
    ]}
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert not dashboard.load_persisted_stats_cache(path)
    payload["version"] = dashboard.PERSISTED_STATS_CACHE_VERSION
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert "today" in dashboard.load_persisted_stats_cache(path)
