from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_dashboard():
    name = "codex_token_dashboard_local_only_contract"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "codex_token_speed_dashboard.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_large_request_uses_regular_rates_without_long_context_fields() -> None:
    dashboard = load_dashboard()
    usage = {
        "input": 300_001,
        "cached": 250_000,
        "output": 10_000,
        "reasoning": 0,
        "cache_write": 0,
        "total": 310_001,
    }

    result = dashboard.price_usage(
        usage,
        "gpt-5.6-sol",
        request_input=300_001,
        cache_write_known=True,
    )

    regular_cost = (
        50_001 * 4.0 + 250_000 * 0.4 + 10_000 * 20.0
    ) / 1_000_000
    regular_credits = (
        50_001 * 100.0 + 250_000 * 10.0 + 10_000 * 500.0
    ) / 1_000_000
    assert result["cost_base"] == pytest.approx(regular_cost)
    assert result["credits"] == pytest.approx(regular_credits)
    assert not any(key.startswith("long_context_") for key in result)


def test_active_backend_and_web_assets_have_no_long_context_surcharge_contract() -> None:
    backend = (ROOT / "codex_token_speed_dashboard.py").read_text(encoding="utf-8")
    active_web = "\n".join(
        (ROOT / "web" / name).read_text(encoding="utf-8")
        for name in ("focus.html", "dashboard.js", "dashboard-core.js")
    )

    assert "long_context_threshold" not in backend
    assert "long_input_multiplier" not in backend
    assert "long_output_multiplier" not in backend
    assert "long_context_" not in active_web
    assert "长上下文" not in active_web


def test_active_routes_and_focus_ui_are_local_only_with_quota_rail_retained() -> None:
    dashboard = load_dashboard()
    backend = (ROOT / "codex_token_speed_dashboard.py").read_text(encoding="utf-8")
    focus = (ROOT / "web" / "focus.html").read_text(encoding="utf-8")
    script = (ROOT / "web" / "dashboard.js").read_text(encoding="utf-8")
    styles = (ROOT / "web" / "dashboard.css").read_text(encoding="utf-8")

    assert "/quota" not in dashboard.WEB_ASSET_ROUTES
    assert "/workbench" not in dashboard.WEB_ASSET_ROUTES
    assert dashboard.WEB_ASSET_ROUTES["/"][0] == "focus.html"
    assert 'href="/quota"' not in focus
    assert 'href="/workbench"' not in focus
    for removed_id in ("quotaDashboard", "sourceSwitch", "shareButton", "sharePanel"):
        assert f'id="{removed_id}"' not in focus
    for retained_id in (
        "railQuotaFivePercent",
        "railQuotaWeeklyPercent",
        "railFiveEstimate",
        "railWeeklyEstimate",
    ):
        assert f'id="{retained_id}"' in focus
    assert "SharingRuntime" not in backend
    assert "/api/share/" not in backend
    assert "params.set('source'" not in script
    assert "state.source" not in script
    assert "/api/share/" not in script
    assert ".share-controls" not in styles
    assert ".share-panel" not in styles
    assert ".quota-dashboard" not in styles


def test_quota_estimate_is_built_from_local_cycle_summary_only() -> None:
    dashboard = load_dashboard()
    now = datetime.fromisoformat("2026-07-12T20:00:00+08:00")
    cycle = {
        "used_percent": 20.0,
        "start": (now - timedelta(hours=1)).isoformat(),
        "reset": (now + timedelta(hours=4)).isoformat(),
        "observed_at": (now - timedelta(minutes=1)).isoformat(),
    }
    summary = {
        "credits": 50.0,
        "total": 1000,
        "request_count": 2,
        "credits_complete": True,
    }

    result = dashboard.build_local_quota_estimate(cycle, summary, now)

    assert result["available"] is True
    assert result["remote_included"] is False
    assert result["credits"] == pytest.approx(50.0)
    assert result["consumed_usd_equivalent"] == pytest.approx(2.0)
    assert result["five_hour_usd_equivalent"] == pytest.approx(10.0)
    assert result["weekly_usd_equivalent"] == pytest.approx(60.0)


def test_local_metrics_runtime_has_no_sync_service_or_network_client(tmp_path: Path) -> None:
    from dashboard_sync.local_runtime import LocalMetricsRuntime

    runtime = LocalMetricsRuntime(tmp_path / "sessions", tmp_path / "local.db")
    try:
        assert runtime.indexer.queue_events is False
        assert not hasattr(runtime, "service")
        assert not hasattr(runtime, "client")
    finally:
        runtime.close()


def test_local_metrics_enrichment_preserves_local_active_duration() -> None:
    dashboard = load_dashboard()

    class Store:
        def intervals_between(self, start_ms, end_ms, source_kind):
            assert source_kind == "local"
            return [(start_ms + 1_000, start_ms + 11_000)]

    runtime = SimpleNamespace(store=Store(), scan_once=lambda: 0)
    stats = {
        "range": {
            "start": "2026-07-12T20:00:00+08:00",
            "end": "2026-07-12T20:01:00+08:00",
        },
        "summary": {},
    }

    result = dashboard.enrich_stats_with_local_metrics(
        SimpleNamespace(local_metrics=runtime), stats
    )

    assert result["summary"]["active_duration_ms"] == 10_000
    assert result["summary"]["active_duration_label"] == "少于一分钟"
    assert "share_status" not in result
    assert "shared_view" not in result


def test_slim_build_has_a_new_matching_product_identity() -> None:
    dashboard = load_dashboard()
    launcher_source = (
        ROOT / "launch_token_speed_dashboard.py"
    ).read_text(encoding="utf-8")

    assert dashboard.BUILD_ID == "2026-10-09-sol-pricing-v25"
    assert dashboard.STATS_ENGINE_VERSION == 4
    assert dashboard.PRODUCT_VERSION == 25
    assert "EXPECTED_STATS_ENGINE_VERSION = 4" in launcher_source
    assert "PRODUCT_VERSION = 25" in launcher_source


def test_focus_more_panel_exposes_one_shot_reset_exit_controls() -> None:
    focus = (ROOT / "web" / "focus.html").read_text(encoding="utf-8")
    script = (ROOT / "web" / "dashboard.js").read_text(encoding="utf-8")

    for control_id in (
        "armResetFive",
        "armResetWeekly",
        "cancelResetExit",
        "resetExitStatus",
    ):
        assert f'id="{control_id}"' in focus
    assert "/api/app/quota-reset-exit" in script
    assert "five_hour" in script
    assert "weekly" in script
    assert "completed ? '清除记录' : '取消待命'" in script


def test_slim_package_spec_has_an_independent_candidate_name() -> None:
    spec = (
        ROOT / "packaging" / "CodexTokenDashboard-Slim.spec"
    ).read_text(encoding="utf-8")

    assert "launch_token_speed_dashboard.py" in spec
    assert "name='CodexTokenDashboard-Slim'" in spec
    assert "codex-token-dashboard.ico" in spec
