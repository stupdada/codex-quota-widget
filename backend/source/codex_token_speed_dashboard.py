#!/usr/bin/env python3
"""Local Codex quota, credits, token, and API-equivalent dashboard.

It discovers local Codex session roots, reads active and archived JSONL files,
and deduplicates them by session id without modifying source logs.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict, defaultdict
from collections.abc import Callable
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from quota_reset_exit import QuotaResetExitController, close_codex_desktop
from session_index import persistent_session_index

DEFAULT_WINDOWS = [5, 10, 15, 30, 60, 120, 180]
DEFAULT_SCAN_HOURS = 8
TOKENS_PER_MILLION = 1_000_000
QUOTA_CREDITS_PER_DOLLAR = 25.0
QUOTA_WEEKLY_MULTIPLIER = 6.0
QUOTA_ESTIMATE_STALE_AFTER = timedelta(minutes=10)
QUOTA_ESTIMATE_MIN_USED_PERCENT = 5.0
QUOTA_ESTIMATE_SATURATED_PERCENT = 99.5
BUCKET_PRESETS = [1, 2, 5, 10, 15, 30, 60]
CYCLE_CACHE_TTL_SECONDS = 30
LIVE_QUOTA_CACHE_TTL_SECONDS = 60
LIVE_QUOTA_TIMEOUT_SECONDS = 12
CYCLE_SCAN_DAYS = 14
CYCLE_SCAN_FILE_LIMIT = 120
CYCLE_TAIL_BYTES = 512 * 1024
CYCLE_DEFINITIONS = {
    "five_hour": ("primary", 300),
    "weekly": ("secondary", 7 * 24 * 60),
}
CYCLE_CACHE: dict[str, object] = {}
LIVE_QUOTA_CACHE: dict[str, object] = {}
LIVE_QUOTA_LOCK = threading.Lock()
SCAN_CACHE_MAX_ENTRIES = 16
SCAN_RESULT_CACHE: OrderedDict[
    tuple, tuple[datetime, list[dict], dict[str, int]]
] = OrderedDict()
SCAN_CACHE_LOCK = threading.Lock()
STATS_BUILD_LOCK = threading.Lock()
STATS_BUILD_KEY_LOCKS: dict[tuple, threading.Lock] = {}
STATS_RESPONSE_CACHE_TTL_SECONDS = 30
STATS_RESPONSE_CACHE_MAX_ENTRIES = 12
STATS_RESPONSE_CACHE: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
API_STATS_CACHE_LOCK = threading.Lock()
API_STATS_KEY_LOCKS: dict[tuple, threading.Lock] = {}
API_STATS_RESPONSE_CACHE: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
PERSISTED_STATS_CACHE_VERSION = 4
PERSISTED_STATS_CACHE_MAX_ENTRIES = 8
PERSISTED_STATS_CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
PERSISTED_STATS_CACHE_WRITE_INTERVAL_SECONDS = 60
PERIODIC_STATS_REFRESH_SECONDS = 5 * 60
LOCAL_METRICS_SCAN_INTERVAL_SECONDS = 30
WIDGET_USAGE_RANGES = {"cycle_5h", "cycle_7d", "last_3h", "today", "week"}
APP_ID = "codex-token-dashboard"
API_VERSION = 2
STATS_ENGINE_VERSION = 4
BUILD_ID = "2026-10-09-sol-pricing-v25"
PRODUCT_VERSION = 25
STARTUP_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
STARTUP_VALUE_NAME = "CodexTokenDashboardSource"


def health_payload() -> dict[str, object]:
    return {
        "app_id": APP_ID,
        "api_version": API_VERSION,
        "stats_engine_version": STATS_ENGINE_VERSION,
        "build_id": BUILD_ID,
        "product_version": PRODUCT_VERSION,
        "pid": os.getpid(),
    }


def startup_command() -> str:
    if getattr(sys, "frozen", False):
        command = [sys.executable, "--background"]
    else:
        command = [
            sys.executable,
            str(Path(__file__).resolve().parent / "launch_token_speed_dashboard.py"),
            "--background",
        ]
    return subprocess.list2cmdline(command)


def startup_status() -> dict[str, object]:
    if os.name != "nt":
        return {"supported": False, "enabled": False}
    import winreg

    expected = startup_command()
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, STARTUP_RUN_KEY) as key:
            current, _kind = winreg.QueryValueEx(key, STARTUP_VALUE_NAME)
    except FileNotFoundError:
        current = None
    return {"supported": True, "enabled": current == expected}


def set_startup_enabled(enabled: bool) -> dict[str, object]:
    if os.name != "nt":
        raise OSError("当前系统不支持开机启动设置")
    import winreg

    if enabled:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, STARTUP_RUN_KEY) as key:
            winreg.SetValueEx(
                key, STARTUP_VALUE_NAME, 0, winreg.REG_SZ, startup_command()
            )
    else:
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                STARTUP_RUN_KEY,
                0,
                winreg.KEY_SET_VALUE,
            ) as key:
                winreg.DeleteValue(key, STARTUP_VALUE_NAME)
        except FileNotFoundError:
            pass
    return startup_status()

# Official OpenAI API text-token pricing, USD per 1M tokens.
# Sol rates and Fast credits checked 2026-10-09:
# https://developers.openai.com/api/docs/pricing
# Credits: https://developers.openai.com/codex/pricing
# Fast credits: https://learn.chatgpt.com/docs/agent-configuration/speed
PRICING_PROFILES = {
    "gpt-6.1-sol": {
        "label": "GPT-6.1 Sol",
        "input": 2.00,
        "cached": 0.10,
        "output": 10.00,
        "credits_input": 50.0,
        "credits_cached": 2.5,
        "credits_output": 250.0,
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-6-sol": {
        "label": "GPT-6 Sol",
        "input": 2.00,
        "cached": 0.20,
        "output": 10.00,
        "credits_input": 50.0,
        "credits_cached": 5.0,
        "credits_output": 250.0,
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-6-astra": {
        "label": "GPT-6 Astra",
        "input": 10.00,
        "cached": 1.00,
        "output": 50.00,
        "credits_input": 250.0,
        "credits_cached": 25.0,
        "credits_output": 1_250.0,
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-5.6-sol": {
        "label": "GPT-5.6 Sol",
        "input": 4.00,
        "cached": 0.40,
        "output": 20.00,
        "credits_input": 100.0,
        "credits_cached": 10.0,
        "credits_output": 500.0,
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-5.6-terra": {
        "label": "GPT-5.6 Terra",
        "input": 2.00,
        "cached": 0.20,
        "output": 12.00,
        "credits_input": 50.0,
        "credits_cached": 5.0,
        "credits_output": 300.0,
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-5.6-luna": {
        "label": "GPT-5.6 Luna",
        "input": 0.20,
        "cached": 0.02,
        "output": 1.20,
        "credits_input": 5.0,
        "credits_cached": 0.5,
        "credits_output": 30.0,
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-5.5": {
        "label": "GPT-5.5 API",
        "input": 5.00,
        "cached": 0.50,
        "output": 30.00,
        "credits_input": 125.0,
        "credits_cached": 12.5,
        "credits_output": 750.0,
        "cache_write_multiplier": 1.00,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-5.5-cyber": {
        "label": "GPT-5.5 Cyber",
        "input": None,
        "cached": None,
        "output": None,
        "credits_input": 500.0,
        "credits_cached": 50.0,
        "credits_output": 3_000.0,
        "cache_write_multiplier": 1.00,
        "fast_credit_multiplier": None,
    },
    "gpt-5.4": {
        "label": "GPT-5.4",
        "input": 2.50,
        "cached": 0.25,
        "output": 15.00,
        "credits_input": 62.5,
        "credits_cached": 6.25,
        "credits_output": 375.0,
        "cache_write_multiplier": 1.00,
        "fast_credit_multiplier": 2.0,
    },
    "gpt-5.4-mini": {
        "label": "GPT-5.4 Mini",
        "input": 0.75,
        "cached": 0.075,
        "output": 4.50,
        "credits_input": 18.75,
        "credits_cached": 1.875,
        "credits_output": 113.0,
        "cache_write_multiplier": 1.00,
        "fast_credit_multiplier": None,
    },
    "gpt-5.3-codex": {
        "label": "GPT-5.3 Codex",
        "input": 1.75,
        "cached": 0.175,
        "output": 14.00,
        "credits_input": 43.75,
        "credits_cached": 4.375,
        "credits_output": 350.0,
        "cache_write_multiplier": 1.00,
        "fast_credit_multiplier": None,
    },
    "gpt-5.2": {
        "label": "GPT-5.2",
        "input": 1.75,
        "cached": 0.175,
        "output": 14.00,
        "credits_input": 43.75,
        "credits_cached": 4.375,
        "credits_output": 350.0,
        "cache_write_multiplier": 1.00,
        "fast_credit_multiplier": None,
    },
}

MODEL_ALIASES = {
    "gpt-5.6": "gpt-5.6-sol",
    # The local approval reviewer is reported under an internal routing name.
    # Per the dashboard policy, account it conservatively at the Sol rate.
    "codex-auto-review": "gpt-5.6-sol",
    "gpt-5.5-2026-04-23": "gpt-5.5",
    "gpt-5.4-2026-03-05": "gpt-5.4",
    "gpt-5.4-mini-2026-03-17": "gpt-5.4-mini",
    "gpt-5.2-2025-12-11": "gpt-5.2",
}

PRECISION_RANK = {"exact": 0, "bounded": 1, "fallback": 2, "partial": 3}
SUPPORTED_PRESETS = {
    "last_15m",
    "last_1h",
    "last_3h",
    "last_24h",
    "last_48h",
    "last_72h",
    "today",
    "week",
    "cycle",
    "cycle_5h",
    "cycle_7d",
    "custom",
}


class StatsRequestError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def local_now() -> datetime:
    return datetime.now().astimezone()


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value).astimezone()
    except ValueError:
        return None


def parse_local_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = parse_timestamp(value)
    if parsed is not None:
        return parsed
    try:
        naive = datetime.fromisoformat(value)
    except ValueError:
        return None
    if naive.tzinfo is None:
        return naive.replace(tzinfo=local_now().tzinfo)
    return naive.astimezone()


def format_range_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M")


def usage_field(usage: dict, names: list[str]) -> int:
    for name in names:
        value = usage.get(name)
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                return 0
    return 0


def usage_has_field(usage: object, names: list[str]) -> bool:
    if not isinstance(usage, dict):
        return False
    if any(name in usage for name in names):
        return True
    for detail_key in ("input_tokens_details", "output_tokens_details"):
        details = usage.get(detail_key)
        if isinstance(details, dict) and any(name in details for name in names):
            return True
    return False


def usage_detail_field(usage: dict, detail_key: str, names: list[str]) -> int:
    direct = usage_field(usage, names)
    if direct:
        return direct
    details = usage.get(detail_key)
    return usage_field(details, names) if isinstance(details, dict) else 0


def extract_usage(payload: dict) -> dict[str, int]:
    info = payload.get("info") if isinstance(payload, dict) else None
    if isinstance(info, dict):
        usage = (
            info.get("total_token_usage")
            or info.get("usage")
            or info.get("token_usage")
            or info
        )
    else:
        usage = (
            payload.get("total_token_usage")
            or payload.get("usage")
            or payload.get("token_usage")
            or payload
        )
    if not isinstance(usage, dict):
        usage = {}
    result = {
        "input": usage_field(usage, ["input_tokens", "input"]),
        "cached": usage_detail_field(
            usage,
            "input_tokens_details",
            [
                "cached_input_tokens",
                "cached_tokens",
                "cache_read_input_tokens",
                "cache_read_tokens",
            ],
        ),
        "output": usage_field(usage, ["output_tokens", "output"]),
        "reasoning": usage_detail_field(
            usage,
            "output_tokens_details",
            ["reasoning_output_tokens", "reasoning_tokens"],
        ),
        "cache_write": usage_detail_field(
            usage,
            "input_tokens_details",
            ["cache_write_tokens", "cache_creation_input_tokens"],
        ),
        "total": usage_field(usage, ["total_tokens", "total"]),
    }
    if result["total"] == 0:
        result["total"] = result["input"] + result["output"]
    return result


def extract_last_usage(payload: dict) -> dict[str, int] | None:
    info = payload.get("info") if isinstance(payload, dict) else None
    if not isinstance(info, dict):
        return None
    usage = info.get("last_token_usage")
    if not isinstance(usage, dict):
        return None
    result = {
        "input": usage_field(usage, ["input_tokens", "input"]),
        "cached": usage_detail_field(
            usage,
            "input_tokens_details",
            [
                "cached_input_tokens",
                "cached_tokens",
                "cache_read_input_tokens",
                "cache_read_tokens",
            ],
        ),
        "output": usage_field(usage, ["output_tokens", "output"]),
        "reasoning": usage_detail_field(
            usage,
            "output_tokens_details",
            ["reasoning_output_tokens", "reasoning_tokens"],
        ),
        "cache_write": usage_detail_field(
            usage,
            "input_tokens_details",
            ["cache_write_tokens", "cache_creation_input_tokens"],
        ),
        "total": 0,
    }
    # A request total is defined by the API contract as input + output. Some
    # local bookkeeping events retain a stale total while all request fields
    # are zero; those are not billable requests and must fall back to the
    # cumulative counter instead of creating phantom usage.
    result["total"] = result["input"] + result["output"]
    return result if result["total"] > 0 else None


def is_token_event(obj: dict) -> bool:
    payload = obj.get("payload") or {}
    return obj.get("type") == "token_count" or (
        obj.get("type") == "event_msg"
        and isinstance(payload, dict)
        and payload.get("type") == "token_count"
    )


def zero_usage() -> dict[str, int]:
    return {
        "input": 0,
        "cached": 0,
        "output": 0,
        "reasoning": 0,
        "cache_write": 0,
        "total": 0,
    }


def add_usage(left: dict[str, int], right: dict[str, int]) -> None:
    for key, value in right.items():
        left[key] = left.get(key, 0) + value


def delta_usage(before: dict[str, int], after: dict[str, int]) -> dict[str, int]:
    return {key: max(0, after.get(key, 0) - before.get(key, 0)) for key in zero_usage()}


def subtract_usage(left: dict[str, int], right: dict[str, int]) -> dict[str, int]:
    return {key: max(0, left.get(key, 0) - right.get(key, 0)) for key in zero_usage()}


def uncached(usage: dict[str, int]) -> int:
    return max(0, usage.get("input", 0) - usage.get("cached", 0))


def pricing_profiles_for_api() -> list[dict]:
    return [
        {
            "id": profile_id,
            "label": profile["label"],
            "input": profile["input"],
            "cached": profile["cached"],
            "output": profile["output"],
            "credits_input": profile["credits_input"],
            "credits_cached": profile["credits_cached"],
            "credits_output": profile["credits_output"],
            "cache_write_multiplier": profile["cache_write_multiplier"],
            "fast_credit_multiplier": profile["fast_credit_multiplier"],
        }
        for profile_id, profile in PRICING_PROFILES.items()
    ]


def zero_cost() -> dict:
    return {
        "cost_base": 0.0,
        "cost_max": 0.0,
        "cache_write_extra_max": 0.0,
        "credits": 0.0,
        "credits_complete": True,
        "complete": True,
        "models_used": [],
        "unpriced_models": [],
        "unpriced_tokens": 0,
        "pricing_precision": "exact",
        "request_count": 0,
        "service_tiers": [],
    }


def canonical_model(model: object) -> str | None:
    normalized = str(model or "").strip().lower()
    if not normalized:
        return None
    normalized = MODEL_ALIASES.get(normalized, normalized)
    return normalized if normalized in PRICING_PROFILES else None


def merge_precision(left: str, right: str) -> str:
    return max((left, right), key=lambda value: PRECISION_RANK.get(value, 99))


def price_usage(
    usage: dict[str, int],
    model: str,
    *,
    request_input: int | None = None,
    cache_write_known: bool | None = None,
    service_tier: str = "default",
) -> dict:
    result = zero_cost()
    original_model = str(model or "(unknown)")
    normalized = canonical_model(original_model)
    display_model = normalized or original_model
    result["models_used"] = [display_model]
    result["request_count"] = 1 if int(usage.get("total", 0)) > 0 else 0
    tier = str(service_tier or "default").strip().lower()
    # Some local Codex logs used "priority" as a request-side setting. It is
    # neither a model suffix nor a separate price table in this dashboard.
    # Treat it exactly like the ordinary tier and never expose @priority.
    if tier == "priority":
        tier = "default"
    result["service_tiers"] = [tier]
    profile = PRICING_PROFILES.get(normalized or "")
    if profile is None:
        result["complete"] = False
        result["credits_complete"] = False
        result["pricing_precision"] = "partial"
        result["unpriced_models"] = [original_model]
        result["unpriced_tokens"] = int(usage.get("total", 0))
        return result

    recognized_tiers = {"default", "standard", "fast", "flex", "auto"}
    if tier not in recognized_tiers:
        result["complete"] = False
        result["credits_complete"] = False
        result["pricing_precision"] = "partial"
        result["unpriced_models"] = [f"{display_model}@{tier}"]
        result["unpriced_tokens"] = int(usage.get("total", 0))
        return result

    # Local thread settings record the requested tier, not necessarily the API
    # response tier. Flex/auto therefore cannot be assigned an API dollar rate
    # without inventing the actually served tier. Credits still use the public
    # Codex token rate card unless the explicit Codex Fast mode applies.
    api_rates_known = tier in {"default", "standard", "fast"} and all(
        profile.get(key) is not None for key in ("input", "cached", "output")
    )
    input_rate = float(profile["input"] or 0.0)
    cached_rate = float(profile["cached"] or 0.0)
    output_rate = float(profile["output"] or 0.0)
    credits_input_rate = float(profile["credits_input"])
    credits_cached_rate = float(profile["credits_cached"])
    credits_output_rate = float(profile["credits_output"])
    multiplier = float(profile["cache_write_multiplier"])
    uncached_tokens = uncached(usage)
    token_cost = 0.0
    if api_rates_known:
        token_cost = (
            uncached_tokens * input_rate
            + int(usage.get("cached", 0)) * cached_rate
            + int(usage.get("output", 0)) * output_rate
        ) / TOKENS_PER_MILLION
    else:
        result["complete"] = False
        result["pricing_precision"] = "partial"
        result["unpriced_models"] = [f"{display_model}@{tier} (API USD)"]
        result["unpriced_tokens"] = int(usage.get("total", 0))
    if api_rates_known:
        cache_extra_rate = input_rate * max(0.0, multiplier - 1.0)
        if multiplier > 1.0 and cache_write_known is True:
            exact_extra = int(usage.get("cache_write", 0)) * cache_extra_rate / TOKENS_PER_MILLION
            result["cost_base"] = token_cost + exact_extra
            result["cache_write_extra_max"] = 0.0
            result["cost_max"] = result["cost_base"]
        elif multiplier > 1.0:
            result["cost_base"] = token_cost
            result["cache_write_extra_max"] = (
                uncached_tokens * cache_extra_rate / TOKENS_PER_MILLION
            )
            result["cost_max"] = result["cost_base"] + result["cache_write_extra_max"]
            result["pricing_precision"] = "bounded"
        else:
            result["cost_base"] = token_cost
            result["cost_max"] = token_cost

    credits = (
        uncached_tokens * credits_input_rate
        + int(usage.get("cached", 0)) * credits_cached_rate
        + int(usage.get("output", 0)) * credits_output_rate
    ) / TOKENS_PER_MILLION
    if tier == "fast":
        fast_multiplier = profile.get("fast_credit_multiplier")
        if fast_multiplier is None:
            result["credits_complete"] = False
            result["pricing_precision"] = merge_precision(
                result["pricing_precision"], "partial"
            )
        else:
            credits *= float(fast_multiplier)
    result["credits"] = credits
    return result


def add_cost(left: dict, right: dict) -> None:
    for key in ("cost_base", "cost_max", "cache_write_extra_max", "credits"):
        left[key] = float(left.get(key, 0.0)) + float(right.get(key, 0.0))
    left["complete"] = bool(left.get("complete", True)) and bool(
        right.get("complete", True)
    )
    left["credits_complete"] = bool(left.get("credits_complete", True)) and bool(
        right.get("credits_complete", True)
    )
    left["models_used"] = sorted(
        set(left.get("models_used", [])) | set(right.get("models_used", []))
    )
    left["unpriced_models"] = sorted(
        set(left.get("unpriced_models", []))
        | set(right.get("unpriced_models", []))
    )
    left["unpriced_tokens"] = int(left.get("unpriced_tokens", 0)) + int(
        right.get("unpriced_tokens", 0)
    )
    left["pricing_precision"] = merge_precision(
        str(left.get("pricing_precision", "exact")),
        str(right.get("pricing_precision", "exact")),
    )
    left["request_count"] = int(left.get("request_count", 0)) + int(
        right.get("request_count", 0)
    )
    left["service_tiers"] = sorted(
        set(left.get("service_tiers", [])) | set(right.get("service_tiers", []))
    )


def project_name(cwd: str) -> str:
    if not cwd:
        return "(unknown)"
    normalized = cwd.replace("/", "\\")
    parts = [part for part in normalized.split("\\") if part]
    if len(parts) >= 2 and parts[-2].lower() == "codex":
        return parts[-1]
    return cwd if len(cwd) <= 80 else "..." + cwd[-77:]


def short_thread(thread_id: str) -> str:
    return thread_id[:8] if thread_id else "(unknown)"


def is_archived_path(path: Path) -> bool:
    return any(part.lower() == "archived_sessions" for part in path.parts)


def archived_root_for(sessions_root: Path) -> Path:
    if sessions_root.name.lower() == "sessions":
        return sessions_root.parent / "archived_sessions"
    return sessions_root / "archived_sessions"


def normalize_session_roots(values: object) -> list[Path]:
    if values is None:
        return []
    if isinstance(values, (str, Path)):
        raw_values = [values]
    else:
        try:
            raw_values = list(values)  # type: ignore[arg-type]
        except TypeError:
            raw_values = [values]
    roots: list[Path] = []
    seen: set[str] = set()
    for value in raw_values:
        root = Path(value).expanduser()
        try:
            key = str(root.resolve()).casefold()
        except OSError:
            key = str(root.absolute()).casefold()
        if key in seen:
            continue
        seen.add(key)
        roots.append(root)
    return roots


def discover_session_roots(explicit_roots: object = None) -> list[Path]:
    """Discover local Codex homes without recursively searching whole drives."""
    candidates: list[Path] = normalize_session_roots(explicit_roots)
    candidates.append(Path.home() / ".codex" / "sessions")

    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        candidates.append(Path(codex_home).expanduser() / "sessions")

    configured_roots = os.environ.get("CODEX_SESSION_ROOTS", "")
    for value in configured_roots.split(os.pathsep):
        if value.strip():
            candidates.append(Path(value.strip()).expanduser())

    cc_switch_candidates = [
        Path.home() / ".cc-switch" / "settings.json",
        Path(os.environ.get("APPDATA", "")) / "cc-switch" / "settings.json",
        Path(os.environ.get("APPDATA", "")) / "CCSwitch" / "settings.json",
    ]
    for settings_path in cc_switch_candidates:
        if not settings_path.is_file():
            continue
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        config_dir = settings.get("codexConfigDir") if isinstance(settings, dict) else None
        if config_dir:
            candidates.append(Path(str(config_dir)).expanduser() / "sessions")

    # Isolated launcher profiles on Windows commonly live one level below
    # <drive>:\CodexProfiles. Checking this conventional directory is bounded.
    if os.name == "nt":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            profiles_root = Path(f"{letter}:\\CodexProfiles")
            if not profiles_root.is_dir():
                continue
            try:
                profiles = list(profiles_root.iterdir())
            except OSError:
                continue
            for profile in profiles:
                sessions = profile / "sessions"
                if profile.is_dir() and sessions.is_dir():
                    candidates.append(sessions)

    return normalize_session_roots(candidates)


def session_created_at_from_path(path: Path) -> datetime | None:
    match = re.search(
        r"rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})",
        path.name,
    )
    if match:
        try:
            return datetime(
                int(match.group(1)),
                int(match.group(2)),
                int(match.group(3)),
                int(match.group(4)),
                int(match.group(5)),
                int(match.group(6)),
            ).astimezone()
        except ValueError:
            return None

    parts = list(path.parts)
    for index in range(len(parts) - 2):
        year, month, day = parts[index : index + 3]
        if len(year) == 4 and year.isdigit() and month.isdigit() and day.isdigit():
            try:
                return datetime(int(year), int(month), int(day)).astimezone()
            except ValueError:
                continue
    return None


def path_session_id(path: Path) -> str:
    stem = path.stem
    return stem[-36:] if len(stem) >= 36 else stem


UUID7_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


def uuid7_timestamp_ms(value: object) -> int | None:
    text = str(value or "")
    if not UUID7_RE.fullmatch(text):
        return None
    return int(text.replace("-", "")[:12], 16)


def extract_model(payload: dict) -> str | None:
    candidates = [payload]
    for key in ("settings", "thread_settings", "config"):
        value = payload.get(key)
        if isinstance(value, dict):
            candidates.append(value)
    for candidate in candidates:
        model = candidate.get("model")
        if model:
            return str(model)
    collaboration_mode = payload.get("collaboration_mode")
    if isinstance(collaboration_mode, dict):
        settings = collaboration_mode.get("settings")
        if isinstance(settings, dict) and settings.get("model"):
            return str(settings["model"])
    return None


def extract_service_tier(payload: dict) -> str | None:
    """Return the request tier recorded by Codex, when present."""
    candidates = [payload]
    for key in ("settings", "thread_settings", "config"):
        value = payload.get(key)
        if isinstance(value, dict):
            candidates.append(value)
    for candidate in candidates:
        value = candidate.get("service_tier") or candidate.get("serviceTier")
        if value:
            return str(value).strip().lower()
    return None


def extract_subagent_info(payload: dict) -> dict:
    source = payload.get("source")
    subagent = source.get("subagent") if isinstance(source, dict) else None
    thread_spawn = subagent.get("thread_spawn") if isinstance(subagent, dict) else None
    if not isinstance(thread_spawn, dict):
        return {
            "is_subagent": False,
            "parent_thread_id": None,
            "depth": 0,
            "agent_role": None,
            "agent_nickname": None,
        }
    parent_thread_id = thread_spawn.get("parent_thread_id")
    try:
        depth = int(thread_spawn.get("depth") or 0)
    except (TypeError, ValueError):
        depth = 0
    return {
        "is_subagent": True,
        "parent_thread_id": str(parent_thread_id) if parent_thread_id else None,
        "depth": max(0, depth),
        "agent_role": thread_spawn.get("agent_role"),
        "agent_nickname": thread_spawn.get("agent_nickname"),
    }


def parse_number(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def extract_cycle_info(
    payload: dict,
    timestamp: datetime,
    cycle_name: str = "five_hour",
) -> dict | None:
    if not isinstance(payload, dict):
        return None
    rate_limits = payload.get("rate_limits") or {}
    if not isinstance(rate_limits, dict):
        return None
    definition = CYCLE_DEFINITIONS.get(cycle_name)
    if definition is None:
        return None
    preferred_quota_name, expected_window_minutes = definition
    quota_name = None
    quota = None
    window_minutes_int = None
    quota_names = (preferred_quota_name,) + tuple(
        name for name in ("primary", "secondary") if name != preferred_quota_name
    )
    for candidate_name in quota_names:
        candidate = rate_limits.get(candidate_name)
        if not isinstance(candidate, dict):
            continue
        try:
            candidate_window_minutes = int(candidate.get("window_minutes"))
        except (TypeError, ValueError):
            continue
        if candidate_window_minutes == expected_window_minutes:
            quota_name = candidate_name
            quota = candidate
            window_minutes_int = candidate_window_minutes
            break
    if quota_name is None or quota is None or window_minutes_int is None:
        return None
    try:
        resets_at_int = int(quota.get("resets_at"))
    except (TypeError, ValueError):
        return None
    if resets_at_int <= 0:
        return None
    reset_time = datetime.fromtimestamp(resets_at_int).astimezone()
    start_time = reset_time - timedelta(minutes=window_minutes_int)
    return {
        "observed_at": timestamp.isoformat(),
        "cycle_name": cycle_name,
        "quota_name": quota_name,
        "start": start_time.isoformat(),
        "reset": reset_time.isoformat(),
        "window_minutes": window_minutes_int,
        "limit_id": rate_limits.get("limit_id"),
        "limit_name": rate_limits.get("limit_name"),
        "plan_type": rate_limits.get("plan_type"),
        "used_percent": parse_number(quota.get("used_percent")),
    }


def cycle_candidate_sort_key(cycle: dict, now: datetime) -> tuple:
    limit_id = str(cycle.get("limit_id") or "").lower()
    observed = parse_timestamp(cycle.get("observed_at"))
    start = parse_timestamp(cycle.get("start"))
    reset = parse_timestamp(cycle.get("reset"))
    min_time = datetime.min.replace(tzinfo=now.tzinfo)
    contains_now = bool(start and reset and start <= now <= reset)
    return (
        1 if contains_now else 0,
        1 if limit_id == "codex" else 0,
        0 if limit_id.startswith("codex_") else 1,
        observed or min_time,
        start or min_time,
    )


def resolve_codex_executable() -> str:
    candidates: list[Path] = []
    configured = os.environ.get("CODEX_CLI_PATH")
    if configured:
        candidates.append(Path(configured))
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        bin_root = Path(local_app_data) / "OpenAI" / "Codex" / "bin"
        candidates.append(bin_root / "codex.exe")
        if bin_root.exists():
            try:
                versioned = sorted(
                    (path for path in bin_root.glob("*/codex.exe") if path.is_file()),
                    key=lambda path: path.stat().st_mtime_ns,
                    reverse=True,
                )
            except OSError:
                versioned = []
            candidates.extend(versioned)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which("codex") or "codex"


def request_live_rate_limits(timeout: float = LIVE_QUOTA_TIMEOUT_SECONDS) -> dict:
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = subprocess.Popen(
        [resolve_codex_executable(), "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creation_flags,
    )
    if process.stdin is None or process.stdout is None:
        process.kill()
        raise OSError("Codex app-server stdio is unavailable")
    messages: queue.Queue[dict] = queue.Queue()

    def read_messages() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and "id" in value:
                messages.put(value)

    threading.Thread(
        target=read_messages, name="codex-quota-reader", daemon=True
    ).start()
    next_id = 0
    deadline = time.monotonic() + timeout

    def send(method: str, params: dict | None = None) -> dict:
        nonlocal next_id
        next_id += 1
        request_id = next_id
        payload: dict[str, object] = {"id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        process.stdin.write(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        )
        process.stdin.flush()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Codex app-server request timed out: {method}")
            try:
                response = messages.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError(
                    f"Codex app-server request timed out: {method}"
                ) from error
            if int(response.get("id", -1)) != request_id:
                continue
            if response.get("error"):
                error_value = response["error"]
                message = (
                    error_value.get("message")
                    if isinstance(error_value, dict)
                    else str(error_value)
                )
                raise RuntimeError(message or f"Codex app-server failed: {method}")
            result = response.get("result")
            if not isinstance(result, dict):
                raise ValueError(f"Codex app-server returned no result: {method}")
            return result

    try:
        send(
            "initialize",
            {
                "clientInfo": {
                    "name": "codex-token-dashboard",
                    "title": "Codex Token Dashboard",
                    "version": BUILD_ID,
                },
                "capabilities": None,
            },
        )
        return send("account/rateLimits/read")
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()


def cycle_windows_from_rate_limit_response(
    result: dict, observed_at: datetime
) -> dict[str, dict | None]:
    snapshots = result.get("rateLimitsByLimitId") or {}
    snapshot = snapshots.get("codex") if isinstance(snapshots, dict) else None
    if not isinstance(snapshot, dict):
        raise ValueError("Codex did not return the account quota snapshot")
    rate_limits: dict[str, object] = {
        "limit_id": snapshot.get("limitId", "codex"),
        "limit_name": snapshot.get("limitName"),
        "plan_type": snapshot.get("planType"),
    }
    for quota_name in ("primary", "secondary"):
        window = snapshot.get(quota_name)
        if isinstance(window, dict):
            rate_limits[quota_name] = {
                "used_percent": window.get("usedPercent"),
                "window_minutes": window.get("windowDurationMins"),
                "resets_at": window.get("resetsAt"),
            }
    payload = {"rate_limits": rate_limits}
    cycles: dict[str, dict | None] = {}
    for cycle_name in CYCLE_DEFINITIONS:
        cycle = extract_cycle_info(payload, observed_at, cycle_name)
        if cycle is not None:
            cycle["source"] = "app-server"
        cycles[cycle_name] = cycle
    if not any(cycles.values()):
        raise ValueError("Codex returned no usable account quota windows")
    return cycles


def quota_snapshot_signature(cycles: dict[str, dict | None]) -> tuple:
    signature = []
    for cycle_name in CYCLE_DEFINITIONS:
        cycle = cycles.get(cycle_name) or {}
        used = parse_number(cycle.get("used_percent"))
        signature.append((cycle.get("reset"), None if used is None else round(used, 1)))
    return tuple(signature)


def live_snapshot_needs_confirmation(
    previous: dict[str, dict | None] | None,
    current: dict[str, dict | None],
) -> bool:
    if previous is None:
        return True
    for cycle_name in CYCLE_DEFINITIONS:
        old = previous.get(cycle_name) or {}
        new = current.get(cycle_name) or {}
        old_used = parse_number(old.get("used_percent"))
        new_used = parse_number(new.get("used_percent"))
        if old.get("reset") != new.get("reset"):
            return True
        if old_used is not None and new_used is not None:
            if new_used + 1 < old_used or new_used - old_used >= 40:
                return True
    return False


def refresh_live_cycle_windows() -> None:
    try:
        with LIVE_QUOTA_LOCK:
            previous = LIVE_QUOTA_CACHE.get("value")
            previous_cycles = previous if isinstance(previous, dict) else None
        current = cycle_windows_from_rate_limit_response(
            request_live_rate_limits(), local_now()
        )
        if live_snapshot_needs_confirmation(previous_cycles, current):
            confirmed = cycle_windows_from_rate_limit_response(
                request_live_rate_limits(), local_now()
            )
            if quota_snapshot_signature(current) != quota_snapshot_signature(confirmed):
                return
            current = confirmed
        with LIVE_QUOTA_LOCK:
            LIVE_QUOTA_CACHE["value"] = current
            LIVE_QUOTA_CACHE["expires_at"] = local_now() + timedelta(
                seconds=LIVE_QUOTA_CACHE_TTL_SECONDS
            )
    except (OSError, RuntimeError, TimeoutError, ValueError):
        return
    finally:
        with LIVE_QUOTA_LOCK:
            LIVE_QUOTA_CACHE["refreshing"] = False


def find_live_cycle_windows(now: datetime) -> dict[str, dict | None] | None:
    with LIVE_QUOTA_LOCK:
        cached = LIVE_QUOTA_CACHE.get("value")
        expires_at = LIVE_QUOTA_CACHE.get("expires_at")
        fresh = isinstance(expires_at, datetime) and expires_at > now
        if not fresh and not LIVE_QUOTA_CACHE.get("refreshing"):
            LIVE_QUOTA_CACHE["refreshing"] = True
            threading.Thread(
                target=refresh_live_cycle_windows,
                name="codex-quota-refresh",
                daemon=True,
            ).start()
        return cached if isinstance(cached, dict) else None  # type: ignore[return-value]


def session_rank(session: dict) -> tuple:
    events = session.get("events") or []
    if events:
        last_timestamp, latest_usage, _model, _metadata = event_parts(events[-1])
        latest_total = latest_usage.get("total", 0)
    else:
        last_timestamp = datetime.min.replace(tzinfo=local_now().tzinfo)
        latest_total = 0
    return (last_timestamp, latest_total, 0 if session.get("archived") else 1)


def event_parts(event: tuple | list) -> tuple[datetime, dict[str, int], str, dict]:
    """Read both legacy three-field events and metadata-rich four-field events."""
    timestamp = event[0]
    usage = event[1]
    model = event[2]
    metadata = event[3] if len(event) > 3 and isinstance(event[3], dict) else {}
    return timestamp, usage, model, metadata


def effective_event_usage(
    previous: dict[str, int] | None,
    cumulative: dict[str, int],
    metadata: dict,
) -> tuple[dict[str, int], dict[str, int]]:
    """Prefer per-request facts and safely fall back to cumulative deltas."""
    diagnostics = {
        "counter_resets": 0,
        "counter_mismatches": 0,
        "duplicate_events": 0,
        "fallback_events": 0,
    }
    comparable_fields = ("input", "cached", "output", "cache_write", "total")
    duplicate = previous is not None and all(
        int(cumulative.get(key, 0)) == int(previous.get(key, 0))
        for key in comparable_fields
    )
    if duplicate:
        diagnostics["duplicate_events"] = 1
        return zero_usage(), diagnostics

    reset = previous is not None and any(
        int(cumulative.get(key, 0)) < int(previous.get(key, 0))
        for key in ("input", "cached", "output", "total")
    )
    if reset:
        diagnostics["counter_resets"] = 1

    request_usage = metadata.get("request_usage")
    if isinstance(request_usage, dict) and int(request_usage.get("total", 0)) > 0:
        effective = {
            key: max(0, int(request_usage.get(key, 0))) for key in zero_usage()
        }
        if previous is not None and not reset:
            cumulative_delta = delta_usage(previous, cumulative)
            if any(
                cumulative_delta.get(key, 0) != effective.get(key, 0)
                for key in ("input", "cached", "output", "total")
            ):
                diagnostics["counter_mismatches"] = 1
        return effective, diagnostics

    diagnostics["fallback_events"] = 1
    return delta_usage(previous or zero_usage(), cumulative), diagnostics


def new_scan_counts() -> dict[str, int]:
    return {
        "candidate_files": 0,
        "included_files": 0,
        "archived_included": 0,
        "duplicates_skipped": 0,
        "oversize_skipped": 0,
        "future_created_skipped": 0,
        "inherited_token_events_skipped": 0,
        "fork_baselines_skipped": 0,
        "subagent_sessions_included": 0,
        "inherited_baseline_events_skipped": 0,
        "inherited_baseline_tokens_skipped": 0,
        "orphan_subagents": 0,
        "recent_archived_files": 0,
        "invalid_json_lines": 0,
        "unreadable_files": 0,
        "missing_roots": 0,
        "negative_usage_events": 0,
        "total_mismatch_events": 0,
        "reasoning_exceeds_output_events": 0,
        "cached_exceeds_input_events": 0,
        "ambiguous_turn_boundaries": 0,
        "cache_hits": 0,
        "cache_misses": 0,
    }


SESSION_FILE_PARSE_COUNT_KEYS = {
    "inherited_token_events_skipped",
    "fork_baselines_skipped",
    "inherited_baseline_events_skipped",
    "inherited_baseline_tokens_skipped",
    "invalid_json_lines",
    "unreadable_files",
    "negative_usage_events",
    "total_mismatch_events",
    "reasoning_exceeds_output_events",
    "cached_exceeds_input_events",
    "ambiguous_turn_boundaries",
}


def serialize_indexed_session(session: dict | None) -> dict | None:
    if session is None:
        return None
    result = dict(session)
    result["events"] = [
        [timestamp.isoformat(), usage, model, metadata]
        for timestamp, usage, model, metadata in session.get("events") or []
    ]
    return result


def deserialize_indexed_session(session: dict | None) -> dict | None:
    if session is None:
        return None
    result = dict(session)
    events = []
    for event in session.get("events") or []:
        if not isinstance(event, list) or len(event) != 4:
            continue
        try:
            timestamp = datetime.fromisoformat(str(event[0]))
        except (TypeError, ValueError):
            continue
        if timestamp.tzinfo is None:
            timestamp = timestamp.astimezone()
        events.append((timestamp, event[1], event[2], event[3]))
    result["events"] = events
    return result


def project_indexed_session(session: dict, start: datetime, end: datetime) -> dict | None:
    baseline = None
    selected = []
    for event in session.get("events") or []:
        timestamp = event[0]
        if timestamp <= start:
            baseline = event
        elif timestamp <= end:
            selected.append(event)
        else:
            break
    if baseline is not None:
        selected.insert(0, baseline)
    if not selected:
        return None
    result = dict(session)
    result["events"] = selected
    return result


def parse_indexed_session_file(path: Path) -> tuple[dict | None, dict[str, int]]:
    counts = {key: 0 for key in SESSION_FILE_PARSE_COUNT_KEYS}
    primary_sid = path_session_id(path)
    primary_created_ms = uuid7_timestamp_ms(primary_sid)
    cwd = None
    model = None
    current_model = None
    current_service_tier = "default"
    events: list[tuple[datetime, dict[str, int], str, dict]] = []
    baseline_before: tuple[datetime, dict[str, int], str, dict] | None = None
    latest_cycle: dict | None = None
    active_sid: str | None = None
    primary_forked_from: str | None = None
    primary_token_baseline_seen = False
    primary_turn_started = False
    inherited_baseline_usage: dict[str, int] | None = None
    inherited_baseline_event_count = 0
    subagent_info = extract_subagent_info({})
    index_start = datetime(1970, 1, 1, tzinfo=datetime.now().astimezone().tzinfo)
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    counts["invalid_json_lines"] += 1
                    continue
                payload = obj.get("payload") or {}
                if obj.get("type") == "session_meta":
                    record_sid = payload.get("id") or payload.get("session_id")
                    if record_sid:
                        record_sid = str(record_sid)
                        active_sid = record_sid
                    if record_sid == primary_sid:
                        cwd = cwd or payload.get("cwd")
                        model = model or extract_model(payload)
                        primary_forked_from = primary_forked_from or payload.get("forked_from_id")
                        subagent_info = extract_subagent_info(payload)
                elif obj.get("type") == "turn_context":
                    if subagent_info["is_subagent"]:
                        turn_created_ms = uuid7_timestamp_ms(payload.get("turn_id"))
                        if turn_created_ms is None:
                            turn_timestamp = parse_timestamp(obj.get("timestamp"))
                            turn_timestamp_ms = (
                                int(turn_timestamp.timestamp() * 1000)
                                if turn_timestamp is not None
                                else None
                            )
                            if (
                                active_sid != primary_sid
                                or turn_timestamp_ms is None
                                or (
                                    primary_created_ms is not None
                                    and turn_timestamp_ms < primary_created_ms
                                )
                            ):
                                continue
                            counts["ambiguous_turn_boundaries"] += 1
                        if primary_created_ms is not None and turn_created_ms is not None:
                            if turn_created_ms < primary_created_ms:
                                continue
                            active_sid = primary_sid
                    elif primary_forked_from and active_sid != primary_sid:
                        turn_created_ms = uuid7_timestamp_ms(payload.get("turn_id"))
                        if (
                            primary_created_ms is None
                            or turn_created_ms is None
                            or turn_created_ms < primary_created_ms
                        ):
                            continue
                        active_sid = primary_sid
                    primary_turn_started = True
                    turn_model = extract_model(payload)
                    if turn_model:
                        current_model = turn_model
                        model = turn_model
                    current_service_tier = extract_service_tier(payload) or current_service_tier
                elif (
                    obj.get("type") == "event_msg"
                    and isinstance(payload, dict)
                    and payload.get("type") == "thread_settings_applied"
                ):
                    settings_model = extract_model(payload)
                    if settings_model:
                        current_model = settings_model
                        model = settings_model
                    current_service_tier = extract_service_tier(payload) or current_service_tier
                elif is_token_event(obj):
                    if (
                        not subagent_info["is_subagent"]
                        and active_sid is not None
                        and active_sid != primary_sid
                    ):
                        counts["inherited_token_events_skipped"] += 1
                        continue
                    timestamp = parse_timestamp(obj.get("timestamp"))
                    if timestamp is None:
                        continue
                    usage = extract_usage(payload)
                    request_usage = extract_last_usage(payload)
                    usage_fact = request_usage or usage
                    if any(int(usage_fact.get(key, 0)) < 0 for key in zero_usage()):
                        counts["negative_usage_events"] += 1
                    if int(usage_fact.get("total", 0)) != (
                        int(usage_fact.get("input", 0)) + int(usage_fact.get("output", 0))
                    ):
                        counts["total_mismatch_events"] += 1
                    if int(usage_fact.get("reasoning", 0)) > int(usage_fact.get("output", 0)):
                        counts["reasoning_exceeds_output_events"] += 1
                    if int(usage_fact.get("cached", 0)) > int(usage_fact.get("input", 0)):
                        counts["cached_exceeds_input_events"] += 1
                    info = payload.get("info") if isinstance(payload, dict) else None
                    total_raw = None
                    request_raw = None
                    model_context_window = None
                    if isinstance(info, dict):
                        total_raw = info.get("total_token_usage") or info.get("usage") or info.get("token_usage")
                        request_raw = info.get("last_token_usage")
                        model_context_window = info.get("model_context_window")
                    if isinstance(request_raw, dict):
                        raw_input = usage_field(request_raw, ["input_tokens", "input"])
                        raw_output = usage_field(request_raw, ["output_tokens", "output"])
                        raw_total = usage_field(request_raw, ["total_tokens", "total"])
                        if raw_input + raw_output > 0 and raw_total != raw_input + raw_output:
                            counts["total_mismatch_events"] += 1
                    precision_raw = request_raw if request_usage is not None else total_raw
                    event_metadata = {
                        "request_usage": request_usage,
                        "cache_write_known": usage_has_field(
                            precision_raw,
                            ["cache_write_tokens", "cache_creation_input_tokens"],
                        ),
                        "service_tier": current_service_tier,
                        "model_context_window": model_context_window,
                    }
                    event_model = current_model or model or "(unknown)"
                    if subagent_info["is_subagent"] and not primary_turn_started:
                        inherited_baseline_usage = usage
                        inherited_baseline_event_count += 1
                        continue
                    if (
                        primary_forked_from
                        and not subagent_info["is_subagent"]
                        and not primary_token_baseline_seen
                    ):
                        primary_token_baseline_seen = True
                        counts["fork_baselines_skipped"] += 1
                        last_usage = request_usage
                        if last_usage is None:
                            baseline_before = (
                                index_start - timedelta(microseconds=1),
                                usage,
                                event_model,
                                {},
                            )
                            continue
                        inherited_baseline = subtract_usage(usage, last_usage)
                        baseline_before = (
                            index_start - timedelta(microseconds=1),
                            inherited_baseline,
                            event_model,
                            {},
                        )
                        events.append((timestamp, usage, event_model, event_metadata))
                        continue
                    cycle = extract_cycle_info(payload, timestamp)
                    if cycle is not None:
                        latest_cycle = cycle
                    if timestamp < index_start:
                        baseline_before = (timestamp, usage, event_model, event_metadata)
                    else:
                        events.append((timestamp, usage, event_model, event_metadata))
    except OSError:
        counts["unreadable_files"] += 1
        return None, counts
    if inherited_baseline_event_count:
        counts["inherited_baseline_events_skipped"] += inherited_baseline_event_count
        counts["inherited_baseline_tokens_skipped"] += int(
            (inherited_baseline_usage or {}).get("total", 0)
        )
        if baseline_before is None and inherited_baseline_usage is not None:
            baseline_before = (
                index_start - timedelta(microseconds=1),
                inherited_baseline_usage,
                current_model or model or "(unknown)",
                {},
            )
    if baseline_before is not None:
        events.insert(0, baseline_before)
    if not events:
        return None, counts
    events.sort(key=lambda item: item[0])
    return {
        "thread_id": primary_sid,
        "cwd": cwd or "(unknown)",
        "project": project_name(cwd or "(unknown)"),
        "model": model or "(unknown)",
        "path": str(path),
        "archived": is_archived_path(path),
        "events": events,
        "latest_cycle": latest_cycle,
        **subagent_info,
    }, counts


class SessionScanner:
    def __init__(
        self,
        sessions_root: Path | list[Path] | tuple[Path, ...],
        scan_hours: float,
        max_file_mb: int | None = None,
    ):
        raw_roots = (
            list(sessions_root)
            if isinstance(sessions_root, (list, tuple))
            else [sessions_root]
        )
        roots: list[Path] = []
        seen: set[str] = set()
        for value in raw_roots:
            root = Path(value).expanduser()
            key = cache_key_for_path(root)
            if key in seen:
                continue
            seen.add(key)
            roots.append(root)
        self.sessions_roots = roots
        self.sessions_root = roots[0] if roots else Path.home() / ".codex" / "sessions"
        self.scan_hours = scan_hours
        # Session JSONL parsing is streaming. A default size cap would silently
        # remove the entire accumulated usage of a long-running session as soon
        # as the file crosses that boundary. Keep a limit only as an explicit
        # opt-in for callers that prefer incomplete data over reading the file.
        self.max_file_bytes = (
            max_file_mb * 1024 * 1024 if max_file_mb is not None else None
        )
        self.scan_counts = new_scan_counts()
        self.sources: list[dict] = []

    def candidate_paths(self, start: datetime, end: datetime) -> list[Path]:
        since = start - timedelta(hours=1)
        roots = [
            (sessions_root, candidate)
            for sessions_root in self.sessions_roots
            for candidate in (sessions_root, archived_root_for(sessions_root))
        ]
        paths: list[Path] = []
        self.scan_counts = new_scan_counts()
        self.scan_counts["recent_archived_files"] = 0
        source_by_key: dict[str, dict] = {}
        self.sources = []
        for sessions_root in self.sessions_roots:
            source = {
                "path": str(sessions_root),
                "exists": sessions_root.is_dir(),
                "readable": sessions_root.is_dir() and os.access(sessions_root, os.R_OK),
                "candidate_files": 0,
                "included_files": 0,
                "archived_included": 0,
            }
            if not source["exists"]:
                self.scan_counts["missing_roots"] += 1
            self.sources.append(source)
            source_by_key[cache_key_for_path(sessions_root)] = source
        seen_paths: set[str] = set()
        for sessions_root, root in roots:
            if not root.exists():
                continue
            source = source_by_key[cache_key_for_path(sessions_root)]
            for path in root.rglob("*.jsonl"):
                resolved = str(path).lower()
                if resolved in seen_paths:
                    continue
                seen_paths.add(resolved)
                self.scan_counts["candidate_files"] += 1
                source["candidate_files"] += 1
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if (
                    self.max_file_bytes is not None
                    and stat.st_size > self.max_file_bytes
                ):
                    self.scan_counts["oversize_skipped"] += 1
                    continue
                created_at = session_created_at_from_path(path)
                if created_at is not None and created_at > end:
                    self.scan_counts["future_created_skipped"] += 1
                    continue
                modified = datetime.fromtimestamp(stat.st_mtime).astimezone()
                if is_archived_path(path) and modified >= since:
                    self.scan_counts["recent_archived_files"] += 1
                if modified >= since:
                    paths.append(path)
                    self.scan_counts["included_files"] += 1
                    source["included_files"] += 1
                    if is_archived_path(path):
                        self.scan_counts["archived_included"] += 1
                        source["archived_included"] += 1
        return paths

    def count_recent_archived_files(self, start: datetime) -> int:
        since = start - timedelta(hours=1)
        count = 0
        seen: set[str] = set()
        for sessions_root in self.sessions_roots:
            archived_root = archived_root_for(sessions_root)
            if not archived_root.exists():
                continue
            for path in archived_root.rglob("*.jsonl"):
                key = cache_key_for_path(path)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    modified = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
                except OSError:
                    continue
                if modified >= since:
                    count += 1
        return count

    def load_sessions(self, start: datetime, end: datetime) -> list[dict]:
        paths = self.candidate_paths(start, end)
        signatures: list[tuple[str, int, int]] = []
        stats_by_path: dict[str, os.stat_result] = {}
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                continue
            path_key = cache_key_for_path(path)
            signatures.append((path_key, stat.st_size, stat.st_mtime_ns))
            stats_by_path[path_key] = stat
        cache_key = (
            tuple(cache_key_for_path(root) for root in self.sessions_roots),
            tuple(sorted(signatures)),
        )
        parse_count_keys = {
            "duplicates_skipped",
            "inherited_token_events_skipped",
            "fork_baselines_skipped",
            "subagent_sessions_included",
            "inherited_baseline_events_skipped",
            "inherited_baseline_tokens_skipped",
            "orphan_subagents",
            "invalid_json_lines",
            "unreadable_files",
            "negative_usage_events",
            "total_mismatch_events",
            "reasoning_exceeds_output_events",
            "cached_exceeds_input_events",
            "ambiguous_turn_boundaries",
        }
        with SCAN_CACHE_LOCK:
            cached = SCAN_RESULT_CACHE.get(cache_key)
            if cached is not None:
                cached_start, sessions, cached_counts = cached
                if cached_start <= start:
                    SCAN_RESULT_CACHE.move_to_end(cache_key)
                    for key, value in cached_counts.items():
                        self.scan_counts[key] = value
                    self.scan_counts["cache_hits"] = len(paths)
                    return sessions

        try:
            index = persistent_session_index()
        except (OSError, sqlite3.Error):
            index = None
        sessions_by_id: dict[str, dict] = {}
        for path in paths:
            path_key = cache_key_for_path(path)
            stat = stats_by_path.get(path_key)
            if stat is None:
                continue
            cached_file = None
            if index is not None:
                try:
                    cached_file = index.load(
                        path,
                        size=stat.st_size,
                        mtime_ns=stat.st_mtime_ns,
                    )
                except sqlite3.Error:
                    cached_file = None
            if cached_file is None:
                full_session, file_counts = parse_indexed_session_file(path)
                self.scan_counts["cache_misses"] += 1
                if index is not None:
                    try:
                        index.store(
                            path,
                            size=stat.st_size,
                            mtime_ns=stat.st_mtime_ns,
                            session=serialize_indexed_session(full_session),
                            counts=file_counts,
                        )
                    except (OSError, sqlite3.Error):
                        pass
            else:
                serialized_session, file_counts = cached_file
                full_session = deserialize_indexed_session(serialized_session)
                self.scan_counts["cache_hits"] += 1
            for key in SESSION_FILE_PARSE_COUNT_KEYS:
                self.scan_counts[key] += int(file_counts.get(key, 0))
            if full_session is None:
                continue
            session = project_indexed_session(full_session, start, end)
            if session is None:
                continue
            if session.get("is_subagent"):
                self.scan_counts["subagent_sessions_included"] += 1
                if not session.get("parent_thread_id"):
                    self.scan_counts["orphan_subagents"] += 1
            thread_id = str(session["thread_id"])
            existing = sessions_by_id.get(thread_id)
            if existing is None or session_rank(session) > session_rank(existing):
                if existing is not None:
                    self.scan_counts["duplicates_skipped"] += 1
                sessions_by_id[thread_id] = session
            else:
                self.scan_counts["duplicates_skipped"] += 1

        sessions = list(sessions_by_id.values())
        cached_counts = {
            key: int(self.scan_counts.get(key, 0)) for key in parse_count_keys
        }
        with SCAN_CACHE_LOCK:
            SCAN_RESULT_CACHE[cache_key] = (start, sessions, cached_counts)
            SCAN_RESULT_CACHE.move_to_end(cache_key)
            while len(SCAN_RESULT_CACHE) > SCAN_CACHE_MAX_ENTRIES:
                SCAN_RESULT_CACHE.popitem(last=False)
        return sessions

    def _load_sessions_without_persistent_index(
        self, start: datetime, end: datetime
    ) -> list[dict]:
        paths = self.candidate_paths(start, end)
        signatures: list[tuple[str, int, int]] = []
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                continue
            signatures.append((cache_key_for_path(path), stat.st_size, stat.st_mtime_ns))
        cache_key = (
            tuple(cache_key_for_path(root) for root in self.sessions_roots),
            tuple(sorted(signatures)),
        )
        parse_count_keys = {
            "duplicates_skipped",
            "inherited_token_events_skipped",
            "fork_baselines_skipped",
            "subagent_sessions_included",
            "inherited_baseline_events_skipped",
            "inherited_baseline_tokens_skipped",
            "orphan_subagents",
            "invalid_json_lines",
            "unreadable_files",
            "negative_usage_events",
            "total_mismatch_events",
            "reasoning_exceeds_output_events",
            "cached_exceeds_input_events",
            "ambiguous_turn_boundaries",
        }
        with SCAN_CACHE_LOCK:
            cached = SCAN_RESULT_CACHE.get(cache_key)
            if cached is not None:
                cached_start, sessions, cached_counts = cached
                if cached_start <= start:
                    SCAN_RESULT_CACHE.move_to_end(cache_key)
                    for key, value in cached_counts.items():
                        self.scan_counts[key] = value
                    self.scan_counts["cache_hits"] = len(paths)
                    return sessions
        self.scan_counts["cache_misses"] = len(paths)

        sessions_by_id: dict[str, dict] = {}
        for path in paths:
            primary_sid = path_session_id(path)
            primary_created_ms = uuid7_timestamp_ms(primary_sid)
            sid = primary_sid
            cwd = None
            model = None
            current_model = None
            current_service_tier = "default"
            events: list[tuple[datetime, dict[str, int], str, dict]] = []
            baseline_before: tuple[datetime, dict[str, int], str, dict] | None = None
            latest_cycle: dict | None = None
            active_sid: str | None = None
            primary_forked_from: str | None = None
            primary_token_baseline_seen = False
            primary_turn_started = False
            inherited_baseline_usage: dict[str, int] | None = None
            inherited_baseline_event_count = 0
            subagent_info = extract_subagent_info({})
            try:
                with path.open("r", encoding="utf-8", errors="ignore") as handle:
                    for line in handle:
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            self.scan_counts["invalid_json_lines"] += 1
                            continue
                        payload = obj.get("payload") or {}
                        if obj.get("type") == "session_meta":
                            record_sid = payload.get("id") or payload.get("session_id")
                            if record_sid:
                                record_sid = str(record_sid)
                                active_sid = record_sid
                            if record_sid == primary_sid:
                                cwd = cwd or payload.get("cwd")
                                model = model or extract_model(payload)
                                primary_forked_from = primary_forked_from or payload.get("forked_from_id")
                                subagent_info = extract_subagent_info(payload)
                        elif obj.get("type") == "turn_context":
                            if subagent_info["is_subagent"]:
                                turn_created_ms = uuid7_timestamp_ms(payload.get("turn_id"))
                                if turn_created_ms is None:
                                    turn_timestamp = parse_timestamp(obj.get("timestamp"))
                                    turn_timestamp_ms = (
                                        int(turn_timestamp.timestamp() * 1000)
                                        if turn_timestamp is not None
                                        else None
                                    )
                                    if (
                                        active_sid != primary_sid
                                        or turn_timestamp_ms is None
                                        or (
                                            primary_created_ms is not None
                                            and turn_timestamp_ms < primary_created_ms
                                        )
                                    ):
                                        # Forked JSONL files can contain copied parent turns whose
                                        # turn id is absent or non-UUID. They are not child work.
                                        continue
                                    self.scan_counts["ambiguous_turn_boundaries"] += 1
                                if primary_created_ms is not None and turn_created_ms is not None:
                                    if turn_created_ms < primary_created_ms:
                                        continue
                                    active_sid = primary_sid
                            elif primary_forked_from and active_sid != primary_sid:
                                turn_created_ms = uuid7_timestamp_ms(payload.get("turn_id"))
                                if (
                                    primary_created_ms is None
                                    or turn_created_ms is None
                                    or turn_created_ms < primary_created_ms
                                ):
                                    continue
                                active_sid = primary_sid
                            primary_turn_started = True
                            turn_model = extract_model(payload)
                            if turn_model:
                                current_model = turn_model
                                model = turn_model
                            current_service_tier = (
                                extract_service_tier(payload) or current_service_tier
                            )
                        elif (
                            obj.get("type") == "event_msg"
                            and isinstance(payload, dict)
                            and payload.get("type") == "thread_settings_applied"
                        ):
                            settings_model = extract_model(payload)
                            if settings_model:
                                current_model = settings_model
                                model = settings_model
                            current_service_tier = (
                                extract_service_tier(payload) or current_service_tier
                            )
                        elif is_token_event(obj):
                            if (
                                not subagent_info["is_subagent"]
                                and active_sid is not None
                                and active_sid != primary_sid
                            ):
                                self.scan_counts["inherited_token_events_skipped"] += 1
                                continue
                            timestamp = parse_timestamp(obj.get("timestamp"))
                            if timestamp is None:
                                continue
                            usage = extract_usage(payload)
                            request_usage = extract_last_usage(payload)
                            usage_fact = request_usage or usage
                            if any(int(usage_fact.get(key, 0)) < 0 for key in zero_usage()):
                                self.scan_counts["negative_usage_events"] += 1
                            if int(usage_fact.get("total", 0)) != (
                                int(usage_fact.get("input", 0))
                                + int(usage_fact.get("output", 0))
                            ):
                                self.scan_counts["total_mismatch_events"] += 1
                            if int(usage_fact.get("reasoning", 0)) > int(
                                usage_fact.get("output", 0)
                            ):
                                self.scan_counts["reasoning_exceeds_output_events"] += 1
                            if int(usage_fact.get("cached", 0)) > int(
                                usage_fact.get("input", 0)
                            ):
                                self.scan_counts["cached_exceeds_input_events"] += 1
                            info = payload.get("info") if isinstance(payload, dict) else None
                            total_raw = None
                            request_raw = None
                            model_context_window = None
                            if isinstance(info, dict):
                                total_raw = (
                                    info.get("total_token_usage")
                                    or info.get("usage")
                                    or info.get("token_usage")
                                )
                                request_raw = info.get("last_token_usage")
                                model_context_window = info.get("model_context_window")
                            if isinstance(request_raw, dict):
                                raw_input = usage_field(request_raw, ["input_tokens", "input"])
                                raw_output = usage_field(request_raw, ["output_tokens", "output"])
                                raw_total = usage_field(request_raw, ["total_tokens", "total"])
                                if raw_input + raw_output > 0 and raw_total != raw_input + raw_output:
                                    self.scan_counts["total_mismatch_events"] += 1
                            precision_raw = request_raw if request_usage is not None else total_raw
                            event_metadata = {
                                "request_usage": request_usage,
                                "cache_write_known": usage_has_field(
                                    precision_raw,
                                    ["cache_write_tokens", "cache_creation_input_tokens"],
                                ),
                                "service_tier": current_service_tier,
                                "model_context_window": model_context_window,
                            }
                            event_model = current_model or model or "(unknown)"
                            if (
                                subagent_info["is_subagent"]
                                and not primary_turn_started
                            ):
                                inherited_baseline_usage = usage
                                inherited_baseline_event_count += 1
                                continue
                            if (
                                primary_forked_from
                                and not subagent_info["is_subagent"]
                                and not primary_token_baseline_seen
                            ):
                                primary_token_baseline_seen = True
                                self.scan_counts["fork_baselines_skipped"] += 1
                                if timestamp < start:
                                    baseline_before = (
                                        timestamp,
                                        usage,
                                        event_model,
                                        event_metadata,
                                    )
                                    continue
                                last_usage = request_usage
                                if last_usage is None:
                                    baseline_before = (
                                        start - timedelta(microseconds=1),
                                        usage,
                                        event_model,
                                        {},
                                    )
                                    continue
                                inherited_baseline = subtract_usage(usage, last_usage)
                                baseline_before = (
                                    start - timedelta(microseconds=1),
                                    inherited_baseline,
                                    event_model,
                                    {},
                                )
                                if timestamp <= end:
                                    events.append(
                                        (timestamp, usage, event_model, event_metadata)
                                    )
                                continue
                            cycle = extract_cycle_info(payload, timestamp)
                            if cycle is not None:
                                latest_cycle = cycle
                            if timestamp < start:
                                baseline_before = (
                                    timestamp,
                                    usage,
                                    event_model,
                                    event_metadata,
                                )
                            elif timestamp <= end:
                                events.append((timestamp, usage, event_model, event_metadata))
            except OSError:
                self.scan_counts["unreadable_files"] += 1
                continue
            if inherited_baseline_event_count:
                self.scan_counts[
                    "inherited_baseline_events_skipped"
                ] += inherited_baseline_event_count
                self.scan_counts["inherited_baseline_tokens_skipped"] += int(
                    (inherited_baseline_usage or {}).get("total", 0)
                )
                if baseline_before is None and inherited_baseline_usage is not None:
                    baseline_before = (
                        start - timedelta(microseconds=1),
                        inherited_baseline_usage,
                        current_model or model or "(unknown)",
                        {},
                    )
            if baseline_before is not None:
                events.insert(0, baseline_before)
            if events:
                events.sort(key=lambda item: item[0])
                thread_id = sid or path_session_id(path)
                session = {
                    "thread_id": thread_id,
                    "cwd": cwd or "(unknown)",
                    "project": project_name(cwd or "(unknown)"),
                    "model": model or "(unknown)",
                    "path": str(path),
                    "archived": is_archived_path(path),
                    "events": events,
                    "latest_cycle": latest_cycle,
                    **subagent_info,
                }
                if subagent_info["is_subagent"]:
                    self.scan_counts["subagent_sessions_included"] += 1
                    if not subagent_info["parent_thread_id"]:
                        self.scan_counts["orphan_subagents"] += 1
                existing = sessions_by_id.get(thread_id)
                if existing is None or session_rank(session) > session_rank(existing):
                    if existing is not None:
                        self.scan_counts["duplicates_skipped"] += 1
                    sessions_by_id[thread_id] = session
                else:
                    self.scan_counts["duplicates_skipped"] += 1
        sessions = list(sessions_by_id.values())
        cached_counts = {
            key: int(self.scan_counts.get(key, 0)) for key in parse_count_keys
        }
        with SCAN_CACHE_LOCK:
            SCAN_RESULT_CACHE[cache_key] = (start, sessions, cached_counts)
            SCAN_RESULT_CACHE.move_to_end(cache_key)
            while len(SCAN_RESULT_CACHE) > SCAN_CACHE_MAX_ENTRIES:
                SCAN_RESULT_CACHE.popitem(last=False)
        return sessions


def analyze_session_range(session: dict, start: datetime, end: datetime) -> dict:
    usage = zero_usage()
    cost = zero_cost()
    previous_usage = None
    diagnostics = {
        "counter_resets": 0,
        "counter_mismatches": 0,
        "duplicate_events": 0,
        "fallback_events": 0,
    }
    events = session.get("events") or []
    for event in events:
        timestamp, cumulative, model, metadata = event_parts(event)
        if timestamp <= start:
            previous_usage = cumulative
            continue
        if timestamp > end:
            break
        effective, event_diagnostics = effective_event_usage(
            previous_usage,
            cumulative,
            metadata,
        )
        for key, value in event_diagnostics.items():
            diagnostics[key] += value
        if effective["total"] > 0:
            add_usage(usage, effective)
            priced = price_usage(
                effective,
                model,
                request_input=(
                    effective.get("input")
                    if isinstance(metadata.get("request_usage"), dict)
                    else None
                ),
                cache_write_known=metadata.get("cache_write_known"),
                service_tier=str(metadata.get("service_tier") or "default"),
            )
            if event_diagnostics["fallback_events"]:
                priced["pricing_precision"] = merge_precision(
                    str(priced.get("pricing_precision", "exact")),
                    "fallback",
                )
            add_cost(cost, priced)
        previous_usage = cumulative
    return {"usage": usage, "cost": cost, "diagnostics": diagnostics}


def range_delta(session: dict, start: datetime, end: datetime) -> dict[str, int]:
    return analyze_session_range(session, start, end)["usage"]


def bucket_minute(timestamp: datetime) -> datetime:
    return timestamp.replace(second=0, microsecond=0)


def bucket_for(timestamp: datetime, bucket_minutes: int) -> datetime:
    minute = (timestamp.minute // bucket_minutes) * bucket_minutes
    return timestamp.replace(minute=minute, second=0, microsecond=0)


def choose_bucket_minutes(start: datetime, end: datetime) -> int:
    total_minutes = max(1, int((end - start).total_seconds() / 60))
    if total_minutes <= 24 * 60:
        return 1
    if total_minutes <= 7 * 24 * 60:
        return 15
    return 60


def parse_bucket_minutes(value: str | int | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, str) and value.lower() in ("", "auto"):
        return None
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return None
    return minutes if minutes in BUCKET_PRESETS else None


def bucket_label(minutes: int, mode: str) -> str:
    suffix = "自动" if mode == "auto" else "手动"
    return f"{minutes}分钟/{suffix}"


def format_bucket_label(value: datetime, start: datetime, end: datetime) -> str:
    if start.date() == end.date():
        return value.strftime("%H:%M")
    return value.strftime("%m-%d %H:%M")


def build_series(
    sessions: list[dict],
    start: datetime,
    end: datetime,
    bucket_minutes: int,
    project_filter: str,
) -> list[dict]:
    buckets: dict[datetime, dict] = defaultdict(
        lambda: {"usage": zero_usage(), "cost": zero_cost()}
    )
    current = bucket_for(start, bucket_minutes)
    while current < end:
        buckets[current]
        current += timedelta(minutes=bucket_minutes)

    for session in sessions:
        if project_filter and project_filter.lower() not in session["cwd"].lower():
            continue
        events = session["events"]
        previous_usage = None
        for event in events:
            timestamp, usage, model, metadata = event_parts(event)
            if timestamp <= start:
                previous_usage = usage
                continue
            if timestamp > end:
                break
            effective, event_diagnostics = effective_event_usage(
                previous_usage,
                usage,
                metadata,
            )
            event_time = min(timestamp, end - timedelta(microseconds=1))
            bucket = buckets[bucket_for(event_time, bucket_minutes)]
            if effective["total"] > 0:
                add_usage(bucket["usage"], effective)
                priced = price_usage(
                    effective,
                    model,
                    request_input=(
                        effective.get("input")
                        if isinstance(metadata.get("request_usage"), dict)
                        else None
                    ),
                    cache_write_known=metadata.get("cache_write_known"),
                    service_tier=str(metadata.get("service_tier") or "default"),
                )
                if event_diagnostics["fallback_events"]:
                    priced["pricing_precision"] = merge_precision(
                        str(priced.get("pricing_precision", "exact")),
                        "fallback",
                    )
                add_cost(bucket["cost"], priced)
            previous_usage = usage

    series = []
    for minute, bucket in sorted(buckets.items()):
        usage = bucket["usage"]
        cost = bucket["cost"]
        overlap_start = max(minute, start)
        overlap_end = min(minute + timedelta(minutes=bucket_minutes), end)
        effective_minutes = max(
            0.0,
            (overlap_end - overlap_start).total_seconds() / 60,
        )
        series.append({
            "time": format_bucket_label(minute, start, end),
            "iso": minute.isoformat(),
            "effective_minutes": effective_minutes,
            "total": usage["total"],
            "input": usage["input"],
            "cached": usage["cached"],
            "uncached": uncached(usage),
            "output": usage["output"],
            "reasoning": usage["reasoning"],
            "cache_write": usage["cache_write"],
            "cost": cost["cost_base"],
            "cost_base": cost["cost_base"],
            "cost_max": cost["cost_max"],
            "cost_complete": cost["complete"],
            "credits": cost["credits"],
            "credits_complete": cost["credits_complete"],
            "pricing_precision": cost["pricing_precision"],
            "request_count": cost["request_count"],
            "service_tiers": cost["service_tiers"],
            "models_used": cost["models_used"],
            "unpriced_models": cost["unpriced_models"],
            "unpriced_tokens": int(cost.get("unpriced_tokens", 0)),
        })
    return series


def summarize(
    sessions: list[dict],
    start: datetime,
    end: datetime,
    project_filter: str = "",
) -> dict:
    filtered = [
        session
        for session in sessions
        if not project_filter or project_filter.lower() in session["cwd"].lower()
    ]
    total = zero_usage()
    total_cost = zero_cost()
    by_cwd: dict[str, dict] = defaultdict(
        lambda: {"usage": zero_usage(), "cost": zero_cost()}
    )
    now = local_now()
    analyses: dict[str, dict] = {}
    accounting_diagnostics = {
        "counter_resets": 0,
        "counter_mismatches": 0,
        "duplicate_events": 0,
        "fallback_events": 0,
    }

    for session in filtered:
        analysis = analyze_session_range(session, start, end)
        analyses[session["thread_id"]] = analysis
        usage = analysis["usage"]
        cost = analysis["cost"]
        for key in accounting_diagnostics:
            accounting_diagnostics[key] += int(analysis["diagnostics"].get(key, 0))
        if usage["total"] > 0:
            add_usage(total, usage)
            add_cost(total_cost, cost)
            add_usage(by_cwd[session["cwd"]]["usage"], usage)
            add_cost(by_cwd[session["cwd"]]["cost"], cost)

    cwd_rows = []
    for cwd, aggregate in by_cwd.items():
        usage = aggregate["usage"]
        cost = aggregate["cost"]
        cwd_rows.append(
            {
                "cwd": cwd,
                "project": project_name(cwd),
                "total": usage["total"],
                "input": usage["input"],
                "cached": usage["cached"],
                "uncached": uncached(usage),
                "output": usage["output"],
                "reasoning": usage["reasoning"],
                "cache_write": usage["cache_write"],
                "cost": cost["cost_base"],
                "cost_base": cost["cost_base"],
                "cost_max": cost["cost_max"],
                "cost_complete": cost["complete"],
                "credits": cost["credits"],
                "credits_complete": cost["credits_complete"],
                "pricing_precision": cost["pricing_precision"],
                "request_count": cost["request_count"],
                "service_tiers": cost["service_tiers"],
                "models_used": cost["models_used"],
                "unpriced_models": cost["unpriced_models"],
                "unpriced_tokens": int(cost.get("unpriced_tokens", 0)),
            }
        )
    cwd_rows.sort(
        key=lambda row: (float(row.get("credits", 0.0)), int(row.get("total", 0))),
        reverse=True,
    )

    sessions_by_id = {session["thread_id"]: session for session in filtered}
    children_by_parent: dict[str, list[str]] = defaultdict(list)
    roots = []
    orphan_count = 0
    for session in filtered:
        thread_id = session["thread_id"]
        parent_id = session.get("parent_thread_id")
        if session.get("is_subagent") and parent_id in sessions_by_id:
            children_by_parent[parent_id].append(thread_id)
        else:
            roots.append(thread_id)
            if session.get("is_subagent"):
                orphan_count += 1

    warnings: list[str] = []

    def aggregate_family(thread_id: str, path_seen: set[str]) -> dict:
        if thread_id in path_seen:
            warning = f"subagent lineage cycle stopped at {thread_id}"
            if warning not in warnings:
                warnings.append(warning)
            return {
                "usage": zero_usage(),
                "cost": zero_cost(),
                "members": set(),
                "member_order": [],
                "max_depth": 0,
            }
        session = sessions_by_id[thread_id]
        analysis = analyses[thread_id]
        family_usage = dict(analysis["usage"])
        family_cost = zero_cost()
        add_cost(family_cost, analysis["cost"])
        members = {thread_id}
        member_order = [thread_id]
        max_depth = int(session.get("depth") or 0)
        next_seen = set(path_seen)
        next_seen.add(thread_id)
        for child_id in sorted(children_by_parent.get(thread_id, [])):
            child = aggregate_family(child_id, next_seen)
            add_usage(family_usage, child["usage"])
            add_cost(family_cost, child["cost"])
            members.update(child["members"])
            member_order.extend(child["member_order"])
            max_depth = max(max_depth, child["max_depth"])
        return {
            "usage": family_usage,
            "cost": family_cost,
            "members": members,
            "member_order": member_order,
            "max_depth": max_depth,
        }

    threads = []
    covered: set[str] = set()
    root_candidates = list(dict.fromkeys(roots))
    root_candidates.extend(
        thread_id for thread_id in sessions_by_id if thread_id not in root_candidates
    )
    for root_id in root_candidates:
        if root_id in covered:
            continue
        family = aggregate_family(root_id, set())
        covered.update(family["members"])
        family_usage = family["usage"]
        if family_usage["total"] == 0:
            continue
        root_session = sessions_by_id[root_id]
        self_usage = analyses[root_id]["usage"]
        family_cost = family["cost"]
        last_timestamp = max(
            sessions_by_id[member_id]["events"][-1][0]
            for member_id in family["members"]
        )
        member_rows = []
        for member_id in family["member_order"]:
            member_session = sessions_by_id[member_id]
            member_analysis = analyses[member_id]
            member_usage = member_analysis["usage"]
            member_cost = member_analysis["cost"]
            member_rows.append(
                {
                    "thread_id": member_id,
                    "short_thread": short_thread(member_id),
                    "parent_thread_id": member_session.get("parent_thread_id"),
                    "parent_short_thread": short_thread(
                        member_session.get("parent_thread_id") or ""
                    ),
                    "depth": int(member_session.get("depth") or 0),
                    "is_subagent": bool(member_session.get("is_subagent")),
                    "agent_role": member_session.get("agent_role"),
                    "agent_nickname": member_session.get("agent_nickname"),
                    "cwd": member_session.get("cwd") or "",
                    "project": member_session.get("project")
                    or project_name(member_session.get("cwd") or ""),
                    "model": member_session.get("model") or "(unknown)",
                    "models_used": member_cost["models_used"],
                    "total": member_usage["total"],
                    "input": member_usage["input"],
                    "cached": member_usage["cached"],
                    "uncached": uncached(member_usage),
                    "output": member_usage["output"],
                    "reasoning": member_usage["reasoning"],
                    "cache_write": member_usage["cache_write"],
                    "cost_base": member_cost["cost_base"],
                    "cost_max": member_cost["cost_max"],
                    "cost_complete": member_cost["complete"],
                    "credits": member_cost["credits"],
                    "credits_complete": member_cost["credits_complete"],
                    "pricing_precision": member_cost["pricing_precision"],
                    "request_count": member_cost["request_count"],
                    "service_tiers": member_cost["service_tiers"],
                    "unpriced_models": member_cost["unpriced_models"],
                    "unpriced_tokens": int(member_cost.get("unpriced_tokens", 0)),
                    "last_seen": member_session["events"][-1][0].strftime(
                        "%Y-%m-%d %H:%M:%S"
                    ),
                }
            )
        threads.append(
            {
                "thread_id": root_id,
                "short_thread": short_thread(root_id),
                "cwd": root_session["cwd"],
                "project": root_session["project"],
                "model": root_session["model"],
                "models_used": family_cost["models_used"],
                "self_total": self_usage["total"],
                "subagent_total": max(0, family_usage["total"] - self_usage["total"]),
                "subagent_count": max(0, len(family["members"]) - 1),
                "max_depth": family["max_depth"],
                "orphan": bool(
                    root_session.get("is_subagent")
                    and root_session.get("parent_thread_id") not in sessions_by_id
                ),
                "total": family_usage["total"],
                "input": family_usage["input"],
                "cached": family_usage["cached"],
                "uncached": uncached(family_usage),
                "output": family_usage["output"],
                "reasoning": family_usage["reasoning"],
                "cache_write": family_usage["cache_write"],
                "cost": family_cost["cost_base"],
                "cost_base": family_cost["cost_base"],
                "cost_max": family_cost["cost_max"],
                "cost_complete": family_cost["complete"],
                "credits": family_cost["credits"],
                "credits_complete": family_cost["credits_complete"],
                "pricing_precision": family_cost["pricing_precision"],
                "request_count": family_cost["request_count"],
                "service_tiers": family_cost["service_tiers"],
                "unpriced_models": family_cost["unpriced_models"],
                "unpriced_tokens": int(family_cost.get("unpriced_tokens", 0)),
                "members": member_rows,
                "last_seen": last_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "last_age_min": round((now - last_timestamp).total_seconds() / 60, 1),
            }
        )
    threads.sort(
        key=lambda row: (float(row.get("credits", 0.0)), int(row.get("total", 0))),
        reverse=True,
    )

    latest = []
    for session in filtered:
        last_timestamp, latest_usage, _latest_model, _latest_metadata = event_parts(
            session["events"][-1]
        )
        analysis = analyses[session["thread_id"]]
        range_usage = analysis["usage"]
        range_cost = analysis["cost"]
        latest.append(
            {
                "thread_id": session["thread_id"],
                "short_thread": short_thread(session["thread_id"]),
                "cwd": session["cwd"],
                "project": session["project"],
                "model": session["model"],
                "parent_thread_id": session.get("parent_thread_id"),
                "parent_short_thread": short_thread(session.get("parent_thread_id") or ""),
                "depth": int(session.get("depth") or 0),
                "is_subagent": bool(session.get("is_subagent")),
                "total": range_usage["total"],
                "input": range_usage["input"],
                "cached": range_usage["cached"],
                "uncached": uncached(range_usage),
                "output": range_usage["output"],
                "reasoning": range_usage["reasoning"],
                "cache_write": range_usage["cache_write"],
                "cumulative_total": latest_usage["total"],
                "cost": range_cost["cost_base"],
                "cost_base": range_cost["cost_base"],
                "cost_max": range_cost["cost_max"],
                "cost_complete": range_cost["complete"],
                "credits": range_cost["credits"],
                "credits_complete": range_cost["credits_complete"],
                "pricing_precision": range_cost["pricing_precision"],
                "request_count": range_cost["request_count"],
                "service_tiers": range_cost["service_tiers"],
                "models_used": range_cost["models_used"],
                "unpriced_models": range_cost["unpriced_models"],
                "unpriced_tokens": int(range_cost.get("unpriced_tokens", 0)),
                "last_seen": last_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "last_age_min": round((now - last_timestamp).total_seconds() / 60, 1),
            }
        )
    latest.sort(key=lambda item: item["last_age_min"])
    minutes = max(1 / 60, (end - start).total_seconds() / 60)

    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"),
        "project_filter": project_filter,
        "session_count": len(filtered),
        "summary": {
            "minutes": minutes,
            "total": total["total"],
            "rate": total["total"] / minutes,
            "input": total["input"],
            "cached": total["cached"],
            "uncached": uncached(total),
            "output": total["output"],
            "reasoning": total["reasoning"],
            "cache_write": total["cache_write"],
            "cost": total_cost["cost_base"],
            "cost_rate": total_cost["cost_base"] / minutes,
            "cost_base": total_cost["cost_base"],
            "cost_max": total_cost["cost_max"],
            "cache_write_extra_max": total_cost["cache_write_extra_max"],
            "cost_complete": total_cost["complete"],
            "credits": total_cost["credits"],
            "credits_complete": total_cost["credits_complete"],
            "pricing_precision": total_cost["pricing_precision"],
            "request_count": total_cost["request_count"],
            "service_tiers": total_cost["service_tiers"],
            "models_used": total_cost["models_used"],
            "unpriced_models": total_cost["unpriced_models"],
            "unpriced_tokens": total_cost["unpriced_tokens"],
            "cost_base_per_hour": total_cost["cost_base"] / minutes * 60,
            "cost_max_per_hour": total_cost["cost_max"] / minutes * 60,
            "credits_per_hour": total_cost["credits"] / minutes * 60,
            "active_threads": sum(
                1 for analysis in analyses.values() if analysis["usage"]["total"] > 0
            ),
        },
        "cwd_top": cwd_rows[:10],
        "thread_top": threads[:20],
        "latest": latest[:20],
        "diagnostics": {
            "orphan_subagents": orphan_count,
            "warnings": warnings,
            **accounting_diagnostics,
        },
    }


def cache_key_for_path(path: Path) -> str:
    try:
        return str(path.expanduser().resolve()).lower()
    except OSError:
        return str(path.expanduser()).lower()


def iter_tail_lines(path: Path, max_bytes: int = CYCLE_TAIL_BYTES):
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            read_size = min(size, max_bytes)
            handle.seek(size - read_size)
            data = handle.read(read_size)
    except OSError:
        return
    lines = data.decode("utf-8", errors="ignore").splitlines()
    if size > max_bytes and lines:
        lines = lines[1:]
    for line in reversed(lines):
        yield line


def cycle_candidate_paths(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    now: datetime,
    days: int = CYCLE_SCAN_DAYS,
    limit: int = CYCLE_SCAN_FILE_LIMIT,
) -> list[Path]:
    since = now - timedelta(days=days)
    entries: list[tuple[datetime, Path]] = []
    seen_paths: set[str] = set()
    for session_root in normalize_session_roots(sessions_root):
        for root in [session_root, archived_root_for(session_root)]:
            if not root.exists():
                continue
            for path in root.rglob("*.jsonl"):
                path_key = cache_key_for_path(path)
                if path_key in seen_paths:
                    continue
                seen_paths.add(path_key)
                try:
                    modified = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
                except OSError:
                    continue
                if modified >= since:
                    entries.append((modified, path))
    entries.sort(key=lambda item: item[0], reverse=True)

    paths: list[Path] = []
    seen_sessions: set[str] = set()
    for _, path in entries:
        session_id = path_session_id(path).lower()
        if session_id in seen_sessions:
            continue
        seen_sessions.add(session_id)
        paths.append(path)
        if len(paths) >= limit:
            break
    return paths


def find_cycle_windows_fast(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    now: datetime,
) -> dict[str, dict | None]:
    cutoff = now - timedelta(days=CYCLE_SCAN_DAYS)
    best_cycles: dict[str, dict | None] = {
        cycle_name: None for cycle_name in CYCLE_DEFINITIONS
    }
    best_keys: dict[str, tuple | None] = {
        cycle_name: None for cycle_name in CYCLE_DEFINITIONS
    }
    for index, path in enumerate(cycle_candidate_paths(sessions_root, now), start=1):
        for line in iter_tail_lines(path):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not is_token_event(obj):
                continue
            timestamp = parse_timestamp(obj.get("timestamp"))
            if timestamp is None or timestamp < cutoff:
                continue
            for cycle_name in CYCLE_DEFINITIONS:
                cycle = extract_cycle_info(
                    obj.get("payload") or {},
                    timestamp,
                    cycle_name,
                )
                if cycle is None:
                    continue
                cycle["source"] = "tail-cache"
                cycle["files_scanned"] = index
                cycle["path"] = str(path)
                key = cycle_candidate_sort_key(cycle, now)
                best_key = best_keys[cycle_name]
                if best_key is None or key > best_key:
                    best_keys[cycle_name] = key
                    best_cycles[cycle_name] = cycle
    return best_cycles


def collect_quota_observations(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    now: datetime,
) -> list[dict]:
    """Collect recent canonical Codex quota snapshots from bounded log tails."""
    cutoff = now - timedelta(days=CYCLE_SCAN_DAYS)
    observations: list[dict] = []
    seen: set[tuple] = set()
    for path in cycle_candidate_paths(sessions_root, now):
        for line in iter_tail_lines(path):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not is_token_event(obj):
                continue
            timestamp = parse_timestamp(obj.get("timestamp"))
            if timestamp is None or timestamp < cutoff or timestamp > now + timedelta(minutes=5):
                continue
            payload = obj.get("payload") or {}
            rate_limits = payload.get("rate_limits") if isinstance(payload, dict) else None
            if not isinstance(rate_limits, dict):
                continue
            if str(rate_limits.get("limit_id") or "").lower() != "codex":
                continue
            five_hour = extract_cycle_info(payload, timestamp, "five_hour")
            weekly = extract_cycle_info(payload, timestamp, "weekly")
            if five_hour is None and weekly is None:
                continue
            key = (
                timestamp.isoformat(),
                five_hour.get("reset") if five_hour else None,
                five_hour.get("used_percent") if five_hour else None,
                weekly.get("reset") if weekly else None,
                weekly.get("used_percent") if weekly else None,
            )
            if key in seen:
                continue
            seen.add(key)
            observations.append(
                {
                    "observed_at": timestamp.isoformat(),
                    "five_hour": five_hour,
                    "weekly": weekly,
                }
            )
    observations.sort(key=lambda item: item["observed_at"])
    return observations


def find_cycle_window_fast(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    now: datetime,
    cycle_name: str = "five_hour",
) -> dict | None:
    return find_cycle_windows_fast(sessions_root, now).get(cycle_name)


def find_cycle_windows(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    now: datetime,
) -> dict[str, dict | None]:
    roots = normalize_session_roots(sessions_root)
    roots_key = tuple(cache_key_for_path(root) for root in roots)
    expires_at = CYCLE_CACHE.get("expires_at")
    if (
        CYCLE_CACHE.get("roots_key") == roots_key
        and isinstance(expires_at, datetime)
        and expires_at > now
    ):
        cached = CYCLE_CACHE.get("value")
        if isinstance(cached, dict):
            return cached  # type: ignore[return-value]
    codex_home = Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
    default_root_key = cache_key_for_path(codex_home / "sessions")
    if any(cache_key_for_path(root) == default_root_key for root in roots):
        live = find_live_cycle_windows(now)
        if live is not None:
            return live
    candidates = cycle_candidate_paths(roots, now)
    signatures: list[tuple[str, int, int]] = []
    for path in candidates:
        try:
            stat = path.stat()
        except OSError:
            continue
        signatures.append((cache_key_for_path(path), stat.st_size, stat.st_mtime_ns))
    key = (
        tuple(cache_key_for_path(root) for root in roots),
        tuple(signatures),
    )
    expires_at = CYCLE_CACHE.get("expires_at")
    if (
        CYCLE_CACHE.get("key") == key
        and isinstance(expires_at, datetime)
        and expires_at > now
    ):
        cached = CYCLE_CACHE.get("value")
        if isinstance(cached, dict):
            return cached  # type: ignore[return-value]

    cycles = find_cycle_windows_fast(roots, now)
    expires_at = now + timedelta(seconds=CYCLE_CACHE_TTL_SECONDS)
    resets = [
        parse_timestamp(cycle.get("reset"))
        for cycle in cycles.values()
        if isinstance(cycle, dict)
    ]
    future_resets = [reset for reset in resets if reset is not None and reset > now]
    if future_resets:
        expires_at = min(expires_at, min(future_resets))
    CYCLE_CACHE.clear()
    CYCLE_CACHE.update(
        {
            "roots_key": roots_key,
            "key": key,
            "expires_at": expires_at,
            "value": cycles,
        }
    )
    return cycles


def find_cycle_window(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    now: datetime,
    cycle_name: str = "five_hour",
) -> dict | None:
    return find_cycle_windows(sessions_root, now).get(cycle_name)


def resolve_range(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    preset: str,
    start_value: str | None,
    end_value: str | None,
    now: datetime,
    cycles: dict[str, dict | None] | None = None,
) -> tuple[datetime, datetime, dict]:
    preset = (preset or "last_3h").lower()
    end = now
    label = "最近3小时"
    cycle = None

    recent_minutes = {
        "last_15m": 15,
        "last_1h": 60,
        "last_3h": 180,
        "last_24h": 1440,
        "last_48h": 2880,
        "last_72h": 4320,
    }
    if preset in recent_minutes:
        minutes = recent_minutes[preset]
        start = end - timedelta(minutes=minutes)
        label = {
            "last_15m": "最近15分钟",
            "last_1h": "最近1小时",
            "last_3h": "最近3小时",
            "last_24h": "最近24小时",
            "last_48h": "最近48小时",
            "last_72h": "最近72小时",
        }[preset]
    elif preset == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        label = "今日"
    elif preset == "week":
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start = start_of_day - timedelta(days=start_of_day.weekday())
        label = "本周"
    elif preset in ("cycle", "cycle_5h", "cycle_7d"):
        cycle_name = "weekly" if preset == "cycle_7d" else "five_hour"
        fallback_minutes = CYCLE_DEFINITIONS[cycle_name][1]
        cycle = (
            cycles.get(cycle_name)
            if isinstance(cycles, dict)
            else find_cycle_window(sessions_root, now, cycle_name)
        )
        cycle_start = parse_timestamp(cycle.get("start")) if cycle else None
        cycle_reset = parse_timestamp(cycle.get("reset")) if cycle else None
        if cycle and cycle_start and cycle_reset and cycle_start <= now < cycle_reset:
            start = cycle_start
            end = min(end, cycle_reset)
            label = "7d周期" if cycle_name == "weekly" else "5h周期"
        else:
            cycle = None
            start = end - timedelta(minutes=fallback_minutes)
            label = (
                "7d周期（未读到重置点，暂按7天）"
                if cycle_name == "weekly"
                else "5h周期（未读到重置点，暂按5小时）"
            )
    elif preset == "custom":
        custom_start = parse_local_datetime(start_value)
        custom_end = parse_local_datetime(end_value)
        if custom_start is None:
            custom_start = end - timedelta(hours=3)
        if custom_end is None:
            custom_end = end
        start, end = custom_start, custom_end
        label = "自定义"
    else:
        start = end - timedelta(hours=3)

    if end > now:
        end = now
    if start >= end:
        start = end - timedelta(minutes=15)
    bucket_minutes = choose_bucket_minutes(start, end)
    return start, end, {
        "preset": preset,
        "label": label,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "start_label": format_range_time(start),
        "end_label": format_range_time(end),
        "minutes": max(1 / 60, (end - start).total_seconds() / 60),
        "bucket_minutes": bucket_minutes,
        "cycle": cycle,
    }


def validate_stats_request(
    preset: str,
    start_value: str | None,
    end_value: str | None,
    bucket_value: str | None,
) -> str:
    normalized = (preset or "last_3h").strip().lower()
    if normalized not in SUPPORTED_PRESETS:
        raise StatsRequestError("invalid_preset", f"不支持的时间范围：{preset}")
    if normalized == "custom":
        start = parse_local_datetime(start_value)
        end = parse_local_datetime(end_value)
        if start is None or end is None:
            raise StatsRequestError("invalid_custom_range", "自定义范围必须包含有效的开始和结束时间")
        if start >= end:
            raise StatsRequestError("invalid_custom_range", "自定义范围的开始时间必须早于结束时间")
    if bucket_value is not None and str(bucket_value).strip().lower() not in ("", "auto"):
        if parse_bucket_minutes(bucket_value) is None:
            raise StatsRequestError("invalid_bucket", f"不支持的趋势粒度：{bucket_value}")
    return normalized


def _make_stats_unlocked(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    preset: str,
    start_value: str | None,
    end_value: str | None,
    scan_hours: float,
    project_filter: str,
    bucket_value: str | None = None,
) -> dict:
    roots = normalize_session_roots(sessions_root)
    if not roots:
        roots = [Path.home() / ".codex" / "sessions"]
    preset = validate_stats_request(preset, start_value, end_value, bucket_value)
    if not any(root.is_dir() for root in roots):
        raise StatsRequestError(
            "no_session_roots",
            "没有可读取的 Codex sessions 目录",
            status=500,
        )
    now = local_now()
    cycles = find_cycle_windows(roots, now)
    start, end, range_info = resolve_range(
        roots,
        preset,
        start_value,
        end_value,
        now,
        cycles,
    )
    manual_bucket = parse_bucket_minutes(bucket_value)
    bucket_minutes = manual_bucket or int(range_info["bucket_minutes"])
    bucket_mode = "manual" if manual_bucket else "auto"
    range_info["bucket_minutes"] = bucket_minutes
    range_info["bucket_mode"] = bucket_mode
    range_info["bucket_label"] = bucket_label(bucket_minutes, bucket_mode)

    scanner = SessionScanner(roots, scan_hours)
    sessions = scanner.load_sessions(start, end)
    stats = summarize(sessions, start, end, project_filter)
    stats["series"] = build_series(
        sessions,
        start,
        end,
        bucket_minutes,
        project_filter,
    )
    stats["range"] = range_info
    stats["cycles"] = cycles
    stats["scan_hours"] = scan_hours
    stats["sessions_root"] = str(roots[0])
    stats["session_roots"] = [str(root) for root in roots]
    stats["sources"] = scanner.sources
    stats["archive_policy"] = "included_deduplicated"
    stats["app"] = health_payload()
    scanner.scan_counts["orphan_subagents"] = int(
        (stats.get("diagnostics") or {}).get("orphan_subagents", 0)
    )
    stats["scan_counts"] = scanner.scan_counts
    source_error_keys = (
        "missing_roots",
        "unreadable_files",
        "invalid_json_lines",
        "negative_usage_events",
        "total_mismatch_events",
        "reasoning_exceeds_output_events",
        "cached_exceeds_input_events",
        "ambiguous_turn_boundaries",
    )
    source_complete = not any(scanner.scan_counts.get(key, 0) for key in source_error_keys)
    accounting_precision = str(stats["summary"].get("pricing_precision", "exact"))
    stats["data_complete"] = bool(source_complete)
    stats["data_precision"] = (
        "partial"
        if not source_complete or accounting_precision == "partial"
        else accounting_precision
    )
    stats["pricing"] = {
        "mode": "auto",
        "profiles": pricing_profiles_for_api(),
        "models_used": stats["summary"]["models_used"],
        "unpriced_models": stats["summary"]["unpriced_models"],
        "complete": stats["summary"]["cost_complete"],
        "credits_complete": stats["summary"]["credits_complete"],
        "precision": stats["summary"]["pricing_precision"],
    }
    return stats


def make_stats(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    preset: str,
    start_value: str | None,
    end_value: str | None,
    scan_hours: float,
    project_filter: str,
    bucket_value: str | None = None,
    force_refresh: bool = False,
) -> dict:
    cache_key = stats_cache_key(
        sessions_root,
        preset,
        start_value,
        end_value,
        scan_hours,
        project_filter,
        bucket_value,
    )

    # Identical requests share one build, while different ranges can proceed
    # independently. This prevents an idle prefetch from globally blocking a
    # range the user actively selected.
    with STATS_BUILD_LOCK:
        cached = STATS_RESPONSE_CACHE.get(cache_key)
        now = time.monotonic()
        if not force_refresh and cached is not None:
            cached_at, cached_stats = cached
            if now - cached_at <= STATS_RESPONSE_CACHE_TTL_SECONDS:
                STATS_RESPONSE_CACHE.move_to_end(cache_key)
                return copy.deepcopy(cached_stats)
            STATS_RESPONSE_CACHE.pop(cache_key, None)
        key_lock = STATS_BUILD_KEY_LOCKS.setdefault(cache_key, threading.Lock())

    with key_lock:
        with STATS_BUILD_LOCK:
            cached = STATS_RESPONSE_CACHE.get(cache_key)
            now = time.monotonic()
            if not force_refresh and cached is not None:
                cached_at, cached_stats = cached
                if now - cached_at <= STATS_RESPONSE_CACHE_TTL_SECONDS:
                    STATS_RESPONSE_CACHE.move_to_end(cache_key)
                    return copy.deepcopy(cached_stats)
                STATS_RESPONSE_CACHE.pop(cache_key, None)

        stats = _make_stats_unlocked(
            sessions_root,
            preset,
            start_value,
            end_value,
            scan_hours,
            project_filter,
            bucket_value,
        )
        with STATS_BUILD_LOCK:
            STATS_RESPONSE_CACHE[cache_key] = (time.monotonic(), copy.deepcopy(stats))
            STATS_RESPONSE_CACHE.move_to_end(cache_key)
            while len(STATS_RESPONSE_CACHE) > STATS_RESPONSE_CACHE_MAX_ENTRIES:
                STATS_RESPONSE_CACHE.popitem(last=False)
        return stats


def stats_cache_key(
    sessions_root: Path | list[Path] | tuple[Path, ...],
    preset: str,
    start_value: str | None,
    end_value: str | None,
    scan_hours: float,
    project_filter: str,
    bucket_value: str | None = None,
) -> tuple:
    roots = normalize_session_roots(sessions_root)
    return (
        tuple(str(root.expanduser().resolve()).casefold() for root in roots),
        (preset or "last_3h").strip().lower(),
        (start_value or "").strip(),
        (end_value or "").strip(),
        float(scan_hours),
        project_filter.strip(),
        (str(bucket_value).strip().lower() if bucket_value is not None else ""),
    )


def persisted_stats_cache_path() -> Path:
    roaming = os.environ.get("APPDATA")
    base = Path(roaming) if roaming else Path.home() / "AppData" / "Roaming"
    return base / "codex-token-dashboard" / "stats-response-cache.json"


def encode_stats_cache_key(cache_key: tuple) -> str:
    return json.dumps(cache_key, ensure_ascii=False, separators=(",", ":"))


def load_persisted_stats_cache(path: Path) -> OrderedDict[str, dict]:
    entries: OrderedDict[str, dict] = OrderedDict()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return entries
    if not isinstance(payload, dict) or payload.get("version") != PERSISTED_STATS_CACHE_VERSION:
        return entries
    now = time.time()
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list):
        return entries
    valid = []
    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        stats = entry.get("stats")
        try:
            saved_at = float(entry.get("saved_at"))
        except (TypeError, ValueError):
            continue
        if (
            not isinstance(key, str)
            or not isinstance(stats, dict)
            or saved_at > now + 60
            or now - saved_at > PERSISTED_STATS_CACHE_MAX_AGE_SECONDS
        ):
            continue
        valid.append((saved_at, key, {"saved_at": saved_at, "stats": stats}))
    for _saved_at, key, entry in sorted(valid)[-PERSISTED_STATS_CACHE_MAX_ENTRIES:]:
        entries[key] = entry
    return entries


def initialize_persisted_stats_cache(server: ThreadingHTTPServer, path: Path | None = None) -> None:
    cache_path = path or persisted_stats_cache_path()
    server.persisted_stats_cache_path = cache_path  # type: ignore[attr-defined]
    server.persisted_stats_cache_lock = threading.Lock()  # type: ignore[attr-defined]
    server.persisted_stats_cache = load_persisted_stats_cache(cache_path)  # type: ignore[attr-defined]


def remember_persisted_stats(server: ThreadingHTTPServer, cache_key: tuple, stats: dict) -> None:
    cache = getattr(server, "persisted_stats_cache", None)
    lock = getattr(server, "persisted_stats_cache_lock", None)
    path = getattr(server, "persisted_stats_cache_path", None)
    if not isinstance(cache, OrderedDict) or lock is None or not isinstance(path, Path):
        return
    encoded_key = encode_stats_cache_key(cache_key)
    now = time.time()
    with lock:
        existing = cache.get(encoded_key)
        if existing is not None and now - float(existing.get("saved_at", 0.0)) < PERSISTED_STATS_CACHE_WRITE_INTERVAL_SECONDS:
            return
        cache.pop(encoded_key, None)
        cache[encoded_key] = {"saved_at": now, "stats": copy.deepcopy(stats)}
        while len(cache) > PERSISTED_STATS_CACHE_MAX_ENTRIES:
            cache.popitem(last=False)
        payload = {
            "version": PERSISTED_STATS_CACHE_VERSION,
            "entries": [
                {"key": key, "saved_at": value["saved_at"], "stats": value["stats"]}
                for key, value in cache.items()
            ],
        }
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, path)
        except OSError as exc:
            sys.stderr.write(f"stats snapshot persistence failure: {type(exc).__name__}: {exc}\n")
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def read_persisted_stats(server: ThreadingHTTPServer, cache_key: tuple) -> dict | None:
    cache = getattr(server, "persisted_stats_cache", None)
    lock = getattr(server, "persisted_stats_cache_lock", None)
    if not isinstance(cache, OrderedDict) or lock is None:
        return None
    encoded_key = encode_stats_cache_key(cache_key)
    with lock:
        entry = cache.get(encoded_key)
        if entry is None:
            return None
        cache.move_to_end(encoded_key)
        stats = copy.deepcopy(entry["stats"])
        stats["snapshot_cache"] = {
            "state": "stale",
            "saved_at": datetime.fromtimestamp(float(entry["saved_at"])).astimezone().isoformat(),
        }
        return stats


def set_periodic_stats_refresh_target(
    server: ThreadingHTTPServer,
    preset: str,
    start_value: str | None,
    end_value: str | None,
    project_filter: str,
    bucket_value: str | None,
) -> None:
    lock = getattr(server, "periodic_stats_refresh_lock", None)
    if lock is None:
        return
    target = (preset, start_value, end_value, project_filter, bucket_value)
    with lock:
        server.periodic_stats_refresh_target = target  # type: ignore[attr-defined]


def restore_periodic_stats_refresh_target(server: ThreadingHTTPServer) -> bool:
    cache = getattr(server, "persisted_stats_cache", None)
    lock = getattr(server, "persisted_stats_cache_lock", None)
    if not isinstance(cache, OrderedDict) or lock is None:
        return False
    with lock:
        if not cache:
            return False
        encoded_key = next(reversed(cache))
    try:
        cache_key = json.loads(encoded_key)
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(cache_key, list) or len(cache_key) != 7:
        return False
    _roots, preset, start_value, end_value, _scan_hours, project_filter, bucket_value = cache_key
    set_periodic_stats_refresh_target(
        server,
        str(preset or "last_3h"),
        str(start_value) or None,
        str(end_value) or None,
        str(project_filter or ""),
        str(bucket_value) or None,
    )
    return True


def refresh_periodic_stats_once(server: ThreadingHTTPServer) -> bool:
    lock = getattr(server, "periodic_stats_refresh_lock", None)
    if lock is None:
        return False
    with lock:
        target = getattr(server, "periodic_stats_refresh_target", None)
    if not isinstance(target, tuple) or len(target) != 5:
        return False
    preset, start_value, end_value, project_filter, bucket_value = target
    try:
        make_api_stats(
            server,
            preset,
            start_value,
            end_value,
            project_filter,
            bucket_value,
            force_refresh=True,
        )
    except Exception as exc:
        sys.stderr.write(f"periodic stats refresh failure: {type(exc).__name__}: {exc}\n")
        return False
    return True


def run_periodic_stats_refresh(server: ThreadingHTTPServer) -> None:
    stop_event = getattr(server, "periodic_stats_refresh_stop_event", None)
    if stop_event is None:
        return
    while not stop_event.wait(PERIODIC_STATS_REFRESH_SECONDS):
        refresh_periodic_stats_once(server)


def resource_root() -> Path:
    bundled_root = getattr(sys, "_MEIPASS", None)
    return Path(bundled_root) if bundled_root else Path(__file__).resolve().parent


def build_local_quota_estimate(
    cycle: dict | None, summary: dict | None, now: datetime
) -> dict:
    result = {
        "available": False,
        "stale": False,
        "complete": True,
        "credits": 0.0,
        "tokens": 0,
        "consumed_usd_equivalent": 0.0,
        "five_hour_usd_equivalent": None,
        "weekly_usd_equivalent": None,
        "weekly_multiplier": QUOTA_WEEKLY_MULTIPLIER,
        "credits_per_dollar": QUOTA_CREDITS_PER_DOLLAR,
        "remote_included": False,
        "event_count": 0,
        "reason": "quota_unavailable",
    }
    if not isinstance(cycle, dict) or not isinstance(summary, dict):
        return result
    try:
        used_percent = float(cycle.get("used_percent"))
    except (TypeError, ValueError):
        return result
    reset = parse_timestamp(cycle.get("reset"))
    observed = parse_timestamp(cycle.get("observed_at"))
    if reset is None or observed is None:
        result["reason"] = "quota_time_unavailable"
        return result
    result["stale"] = now - observed > QUOTA_ESTIMATE_STALE_AFTER or now >= reset
    if result["stale"]:
        result["reason"] = "quota_stale"
        return result
    result["credits"] = float(summary.get("credits", 0.0) or 0.0)
    result["tokens"] = int(summary.get("total", 0) or 0)
    result["event_count"] = int(summary.get("request_count", 0) or 0)
    result["complete"] = bool(summary.get("credits_complete", True))
    if result["event_count"] <= 0:
        result["reason"] = "usage_unavailable"
        return result
    consumed = result["credits"] / QUOTA_CREDITS_PER_DOLLAR
    result["consumed_usd_equivalent"] = consumed
    if used_percent <= 0:
        result["reason"] = "quota_unused"
        return result
    if used_percent < QUOTA_ESTIMATE_MIN_USED_PERCENT:
        result["reason"] = "quota_sample_too_small"
        return result
    if used_percent >= QUOTA_ESTIMATE_SATURATED_PERCENT:
        result["reason"] = "quota_saturated"
        return result
    five_hour = consumed / (used_percent / 100.0)
    result.update(
        {
            "available": True,
            "five_hour_usd_equivalent": five_hour,
            "weekly_usd_equivalent": five_hour * QUOTA_WEEKLY_MULTIPLIER,
            "reason": "ok" if result["complete"] else "credits_incomplete",
        }
    )
    return result


WEB_ROOT = resource_root() / "web"
WEB_ASSET_ROUTES = {
    "/": ("focus.html", "text/html; charset=utf-8"),
    "/focus": ("focus.html", "text/html; charset=utf-8"),
    "/assets/dashboard.css": ("dashboard.css", "text/css; charset=utf-8"),
    "/assets/dashboard-core.js": ("dashboard-core.js", "text/javascript; charset=utf-8"),
    "/assets/dashboard.js": ("dashboard.js", "text/javascript; charset=utf-8"),
}


def load_web_assets() -> dict[str, tuple[bytes, str]]:
    return {
        route: ((WEB_ROOT / relative_path).read_bytes(), content_type)
        for route, (relative_path, content_type) in WEB_ASSET_ROUTES.items()
    }


WEB_ASSETS = load_web_assets()


def read_web_asset(route: str) -> tuple[bytes, str]:
    try:
        return WEB_ASSETS[route]
    except KeyError as exc:
        raise FileNotFoundError(route) from exc


def enrich_stats_with_local_metrics(
    server: ThreadingHTTPServer, stats: dict
) -> dict:
    runtime = getattr(server, "local_metrics", None)
    if runtime is None:
        return stats
    now = time.monotonic()
    scan_lock = getattr(server, "local_metrics_scan_lock", None)

    def scan_if_due() -> None:
        last_scan = float(getattr(server, "local_metrics_last_scan_monotonic", 0.0))
        if now - last_scan < LOCAL_METRICS_SCAN_INTERVAL_SECONDS:
            return
        server.local_metrics_last_scan_monotonic = now  # type: ignore[attr-defined]
        try:
            runtime.scan_once()
        except (OSError, ValueError):
            pass

    if scan_lock is None:
        scan_if_due()
    else:
        with scan_lock:
            scan_if_due()
    from dashboard_sync.active_time import active_duration_ms, format_active_duration

    range_start = parse_timestamp(stats["range"]["start"])
    range_end = parse_timestamp(stats["range"]["end"])
    if range_start is None or range_end is None:
        return stats
    start_ms = int(range_start.timestamp() * 1000)
    end_ms = int(range_end.timestamp() * 1000)
    duration = active_duration_ms(
        runtime.store.intervals_between(start_ms, end_ms, "local"),
        clip_start=start_ms,
        clip_end=end_ms,
    )
    stats["summary"]["active_duration_ms"] = duration
    stats["summary"]["active_duration_label"] = format_active_duration(duration)
    return stats


def quota_usage_from_sessions(
    sessions: list[dict],
    start: datetime,
    end: datetime,
) -> dict[str, object]:
    usage = zero_usage()
    cost = zero_cost()
    for session in sessions:
        analysis = analyze_session_range(session, start, end)
        add_usage(usage, analysis["usage"])
        add_cost(cost, analysis["cost"])
    return {
        "usd": float(cost["credits"]) / QUOTA_CREDITS_PER_DOLLAR,
        "tokens": int(usage["total"]),
        "event_count": int(cost["request_count"]),
        "complete": bool(cost["credits_complete"]),
    }


class QuotaUsageProvider:
    """Provide quota deltas through the dashboard's canonical deduplicated scanner."""

    def __init__(
        self,
        sessions_roots: Path | list[Path] | tuple[Path, ...],
    ) -> None:
        self.sessions_roots = normalize_session_roots(sessions_roots)
        self._lock = threading.Lock()
        self._sessions: list[dict] = []
        self._loaded_at: datetime | None = None

    def refresh(self, now: datetime) -> None:
        with self._lock:
            if (
                self._loaded_at is not None
                and now - self._loaded_at < timedelta(seconds=30)
            ):
                return
            start = now - timedelta(days=CYCLE_SCAN_DAYS)
            scanner = SessionScanner(
                self.sessions_roots,
                CYCLE_SCAN_DAYS * 24,
            )
            self._sessions = scanner.load_sessions(start, now)
            self._loaded_at = now

    def __call__(self, start: datetime, end: datetime) -> dict[str, object]:
        with self._lock:
            sessions = self._sessions
        return quota_usage_from_sessions(sessions, start, end)


def enrich_stats_with_quota_estimate(
    server: ThreadingHTTPServer,
    stats: dict,
    now: datetime,
) -> dict:
    estimator = getattr(server, "quota_estimator", None)
    if estimator is None:
        stats["quota_estimate"] = build_local_quota_estimate(
            (stats.get("cycles") or {}).get("five_hour"),
            None,
            now,
        )
        return stats
    try:
        cycles = stats.get("cycles") or {}
        estimator.observe(cycles, now)
        usage_provider = getattr(server, "quota_usage_provider", None)
        if usage_provider is not None:
            usage_provider.refresh(now)
        stats["quota_estimate"] = estimator.estimate(cycles, now)
    except Exception as exc:  # Estimation must never take down the stats API.
        sys.stderr.write(
            f"quota estimator failure: {type(exc).__name__}: {exc}\n"
        )
        stats["quota_estimate"] = build_local_quota_estimate(
            (stats.get("cycles") or {}).get("five_hour"),
            None,
            now,
        )
    return stats


def _widget_cycle(cycle: object, now: datetime) -> dict[str, object]:
    if not isinstance(cycle, dict):
        return {
            "remaining_percent": None,
            "used_percent": None,
            "reset_at": None,
            "window_minutes": None,
            "observed_at": None,
            "stale": True,
        }
    used = parse_number(cycle.get("used_percent"))
    if used is None or not math.isfinite(used) or used < 0 or used > 100:
        used = None
    remaining = None if used is None else round(100.0 - used, 4)
    observed = parse_timestamp(cycle.get("observed_at"))
    reset = parse_timestamp(cycle.get("reset"))
    try:
        window_minutes = int(cycle.get("window_minutes"))
    except (TypeError, ValueError):
        window_minutes = None
    stale = (
        observed is None
        or now - observed > QUOTA_ESTIMATE_STALE_AFTER
        or (reset is not None and now >= reset)
    )
    return {
        "remaining_percent": remaining,
        "used_percent": None if used is None else round(used, 4),
        "reset_at": reset.isoformat() if reset is not None else None,
        "window_minutes": window_minutes,
        "observed_at": observed.isoformat() if observed is not None else None,
        "stale": stale,
    }


def _seven_day_ideal_remaining(cycle: dict[str, object], now: datetime) -> float | None:
    reset = parse_timestamp(cycle.get("reset_at"))
    try:
        window_minutes = int(cycle.get("window_minutes"))
    except (TypeError, ValueError):
        return None
    if reset is None or window_minutes <= 0:
        return None
    remaining_seconds = (reset - now).total_seconds()
    window_seconds = window_minutes * 60
    if remaining_seconds < 0 or remaining_seconds > window_seconds + 15 * 60:
        return None
    return round(max(0.0, min(100.0, remaining_seconds / window_seconds * 100.0)), 4)


def build_widget_quota_status(
    five_hour: dict[str, object],
    seven_day: dict[str, object],
    now: datetime,
) -> dict[str, object]:
    cycles = [five_hour, seven_day]
    observed_cycles = [
        cycle for cycle in cycles
        if isinstance(cycle.get("remaining_percent"), (int, float))
    ]
    active_cycles = [cycle for cycle in observed_cycles if not bool(cycle.get("stale"))]
    values = [float(cycle["remaining_percent"]) for cycle in active_cycles]
    ideal = _seven_day_ideal_remaining(seven_day, now)
    seven_remaining = seven_day.get("remaining_percent")
    seven_delta = (
        round(float(seven_remaining) - ideal, 4)
        if isinstance(seven_remaining, (int, float)) and ideal is not None
        else None
    )
    if not observed_cycles:
        state, effect, reason = "unavailable", "blink", "额度数据不可用"
    elif not active_cycles:
        state, effect, reason = "stale", "blink", "额度数据不完整或已过期"
    elif min(float(value) for value in values) <= 10 or (
        seven_delta is not None and seven_delta <= -20
    ):
        state, effect, reason = "critical", "blink", "额度余量偏低"
    elif min(float(value) for value in values) <= 25 or (
        seven_delta is not None and seven_delta <= -10
    ):
        state, effect, reason = "warning", "breathe", "额度消耗快于理想进度"
    else:
        state, effect, reason = "normal", "steady", "额度余量正常"
    return {
        "state": state,
        "effect": effect,
        "reason": reason,
        "seven_day_ideal_remaining": ideal,
        "seven_day_delta": seven_delta,
    }


def record_quota_history(
    server: ThreadingHTTPServer,
    cycles: object,
    *,
    source: str,
) -> None:
    history = getattr(server, "quota_history", None)
    if history is None:
        return
    try:
        history.record_cycles(cycles, source=source)
        history.maintain(local_now())
    except Exception as exc:  # History persistence must not take down the API.
        sys.stderr.write(
            f"quota history persistence failure: {type(exc).__name__}: {exc}\n"
        )


def make_api_stats(
    server: ThreadingHTTPServer,
    preset: str,
    start_value: str | None,
    end_value: str | None,
    project_filter: str,
    bucket_value: str | None,
    *,
    force_refresh: bool = False,
) -> dict:
    roots = getattr(server, "sessions_roots", [server.sessions_root])
    cache_key = stats_cache_key(
        roots,
        preset,
        start_value,
        end_value,
        server.scan_hours,
        project_filter,
        bucket_value,
    )
    with API_STATS_CACHE_LOCK:
        cached = API_STATS_RESPONSE_CACHE.get(cache_key)
        now = time.monotonic()
        if not force_refresh and cached is not None:
            cached_at, cached_stats = cached
            if now - cached_at <= STATS_RESPONSE_CACHE_TTL_SECONDS:
                API_STATS_RESPONSE_CACHE.move_to_end(cache_key)
                return copy.deepcopy(cached_stats)
            API_STATS_RESPONSE_CACHE.pop(cache_key, None)
        key_lock = API_STATS_KEY_LOCKS.setdefault(cache_key, threading.Lock())

    with key_lock:
        with API_STATS_CACHE_LOCK:
            cached = API_STATS_RESPONSE_CACHE.get(cache_key)
            now = time.monotonic()
            if not force_refresh and cached is not None:
                cached_at, cached_stats = cached
                if now - cached_at <= STATS_RESPONSE_CACHE_TTL_SECONDS:
                    API_STATS_RESPONSE_CACHE.move_to_end(cache_key)
                    return copy.deepcopy(cached_stats)
                API_STATS_RESPONSE_CACHE.pop(cache_key, None)

        stats = make_stats(
            roots,
            preset,
            start_value,
            end_value,
            server.scan_hours,
            project_filter,
            bucket_value,
            force_refresh=force_refresh,
        )
        stats = enrich_stats_with_local_metrics(server, stats)
        stats = enrich_stats_with_quota_estimate(server, stats, local_now())
        record_quota_history(server, stats.get("cycles") or {}, source="stats")
        with API_STATS_CACHE_LOCK:
            API_STATS_RESPONSE_CACHE[cache_key] = (
                time.monotonic(),
                copy.deepcopy(stats),
            )
            API_STATS_RESPONSE_CACHE.move_to_end(cache_key)
            while len(API_STATS_RESPONSE_CACHE) > STATS_RESPONSE_CACHE_MAX_ENTRIES:
                API_STATS_RESPONSE_CACHE.popitem(last=False)
        remember_persisted_stats(server, cache_key, stats)
        return stats


def make_widget_payload(
    server: ThreadingHTTPServer,
    usage_range: str,
    now: datetime | None = None,
) -> dict[str, object]:
    normalized = (usage_range or "cycle_5h").strip().lower()
    if normalized not in WIDGET_USAGE_RANGES:
        raise StatsRequestError(
            "invalid_usage_range", f"不支持的小组件用量范围：{usage_range}"
        )
    effective_now = now or local_now()
    stats = make_stats(
        getattr(server, "sessions_roots", [server.sessions_root]),  # type: ignore[attr-defined]
        normalized,
        None,
        None,
        server.scan_hours,  # type: ignore[attr-defined]
        "",
        None,
    )
    cycles = stats.get("cycles") or {}
    record_quota_history(server, cycles, source="widget")
    five_hour = _widget_cycle(cycles.get("five_hour"), effective_now)
    seven_day = _widget_cycle(cycles.get("weekly"), effective_now)
    summary = stats.get("summary") or {}
    range_info = stats.get("range") or {}
    return {
        "version": 1,
        "generated_at": effective_now.isoformat(),
        "quota_status": build_widget_quota_status(five_hour, seven_day, effective_now),
        "cycles": {"five_hour": five_hour, "seven_day": seven_day},
        "usage": {
            "range": normalized,
            "label": range_info.get("label"),
            "start": range_info.get("start"),
            "end": range_info.get("end"),
            "cost_base": float(summary.get("cost_base", 0.0) or 0.0),
            "cost_max": float(summary.get("cost_max", 0.0) or 0.0),
            "cost_complete": bool(summary.get("cost_complete", False)),
            "data_complete": bool(stats.get("data_complete", False)),
        },
    }


def make_quota_history_payload(
    server: ThreadingHTTPServer,
    days: int | None,
    max_points: int,
    now: datetime | None = None,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
) -> dict[str, object]:
    if days is not None and days not in {7, 30, 90, 180}:
        raise StatsRequestError("invalid_days", f"不支持的额度历史范围：{days}")
    if max_points < 2 or max_points > 20_000:
        raise StatsRequestError(
            "invalid_max_points", "max_points 必须介于 2 和 20000 之间"
        )
    history = getattr(server, "quota_history", None)
    if history is None:
        raise StatsRequestError("quota_history_unavailable", "额度历史不可用", 503)
    effective_now = now or local_now()
    range_end = end or effective_now
    range_start = start or (range_end - timedelta(days=days or 7))
    if range_start >= range_end:
        raise StatsRequestError("invalid_quota_history_range", "额度历史开始时间必须早于结束时间")
    if range_end - range_start > timedelta(days=180, minutes=5):
        raise StatsRequestError("invalid_quota_history_range", "额度历史范围不能超过 180 天")
    history.maintain(effective_now)
    return {
        "version": 1,
        "generated_at": effective_now.isoformat(),
        "days": days,
        "start": range_start.isoformat(),
        "end": range_end.isoformat(),
        "samples": history.query_range(range_start, range_end, max_points=max_points),
    }


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "CodexTokenSpeed/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json(health_payload())
            return
        if parsed.path == "/api/app/startup":
            self.send_json(startup_status())
            return
        if parsed.path == "/api/app/quota-reset-exit":
            query = parse_qs(parsed.query)
            refresh = query.get("refresh", ["0"])[0].strip().lower() in {
                "1",
                "true",
                "yes",
            }
            controller = getattr(self.server, "quota_reset_exit", None)  # type: ignore[attr-defined]
            if controller is None:
                self.send_json(
                    {"ok": False, "error": "额度重置退出控制器不可用"}, status=503
                )
                return
            self.send_json({"ok": True, "result": controller.status(refresh=refresh)})
            return
        if parsed.path == "/api/widget":
            request_id = uuid.uuid4().hex
            query = parse_qs(parsed.query)
            usage_range = query.get("usage_range", ["cycle_5h"])[0].strip()
            try:
                payload = make_widget_payload(self.server, usage_range)
            except StatsRequestError as exc:
                self.send_json(
                    {
                        "error": {
                            "code": exc.code,
                            "message": exc.message,
                            "request_id": request_id,
                        }
                    },
                    status=exc.status,
                    request_id=request_id,
                )
                return
            except Exception as exc:
                sys.stderr.write(
                    f"[{request_id}] widget failure: {type(exc).__name__}: {exc}\n"
                )
                self.send_json(
                    {
                        "error": {
                            "code": "internal_error",
                            "message": "小组件统计失败，请稍后重试",
                            "request_id": request_id,
                        }
                    },
                    status=500,
                    request_id=request_id,
                )
                return
            self.send_json(payload, request_id=request_id)
            return
        if parsed.path == "/api/quota-history":
            request_id = uuid.uuid4().hex
            query = parse_qs(parsed.query)
            try:
                try:
                    days_value = query.get("days", [""])[0].strip()
                    days = int(days_value) if days_value else None
                    max_points = int(query.get("max_points", ["3000"])[0])
                except (TypeError, ValueError) as error:
                    raise StatsRequestError(
                        "invalid_quota_history_query", "days 和 max_points 必须是整数"
                    ) from error
                start = parse_timestamp(query.get("start", [""])[0])
                end = parse_timestamp(query.get("end", [""])[0])
                if (start is None) != (end is None):
                    raise StatsRequestError(
                        "invalid_quota_history_range", "start 和 end 必须同时提供"
                    )
                payload = make_quota_history_payload(
                    self.server, days, max_points, start=start, end=end
                )
            except StatsRequestError as exc:
                self.send_json(
                    {
                        "error": {
                            "code": exc.code,
                            "message": exc.message,
                            "request_id": request_id,
                        }
                    },
                    status=exc.status,
                    request_id=request_id,
                )
                return
            except Exception as exc:
                sys.stderr.write(
                    f"[{request_id}] quota history failure: {type(exc).__name__}: {exc}\n"
                )
                self.send_json(
                    {
                        "error": {
                            "code": "internal_error",
                            "message": "额度历史读取失败，请稍后重试",
                            "request_id": request_id,
                        }
                    },
                    status=500,
                    request_id=request_id,
                )
                return
            self.send_json(payload, request_id=request_id)
            return
        if parsed.path in WEB_ASSET_ROUTES:
            body, content_type = read_web_asset(parsed.path)
            self.send_bytes(body, content_type)
            return
        if parsed.path in {"/api/stats", "/api/stats-cache"}:
            request_id = uuid.uuid4().hex
            query = parse_qs(parsed.query)
            preset = query.get("preset", ["last_3h"])[0].strip()
            start_value = query.get("start", [None])[0]
            end_value = query.get("end", [None])[0]
            bucket_value = query.get("bucket", [None])[0]
            project_filter = query.get("project", [""])[0].strip()
            is_prefetch = query.get("prefetch", [""])[0].strip().lower() in {
                "1",
                "true",
                "yes",
            }
            force_refresh = query.get("refresh", [""])[0].strip().lower() in {
                "1",
                "true",
                "yes",
            }
            try:
                validate_stats_request(preset, start_value, end_value, bucket_value)
                if not is_prefetch:
                    set_periodic_stats_refresh_target(
                        self.server,
                        preset,
                        start_value,
                        end_value,
                        project_filter,
                        bucket_value,
                    )
                if parsed.path == "/api/stats-cache":
                    roots = getattr(self.server, "sessions_roots", [self.server.sessions_root])
                    cache_key = stats_cache_key(
                        roots,
                        preset,
                        start_value,
                        end_value,
                        self.server.scan_hours,
                        project_filter,
                        bucket_value,
                    )
                    stats = read_persisted_stats(self.server, cache_key)
                    if stats is None:
                        self.send_json(
                            {"error": {"code": "cache_miss", "message": "暂无统计快照"}},
                            status=404,
                            request_id=request_id,
                        )
                        return
                else:
                    stats = make_api_stats(
                        self.server,
                        preset,
                        start_value,
                        end_value,
                        project_filter,
                        bucket_value,
                        force_refresh=force_refresh,
                    )
            except StatsRequestError as exc:
                self.send_json(
                    {
                        "error": {
                            "code": exc.code,
                            "message": exc.message,
                            "request_id": request_id,
                        }
                    },
                    status=exc.status,
                    request_id=request_id,
                )
                return
            except Exception as exc:  # HTTP boundary: keep local paths/stacks private.
                sys.stderr.write(
                    f"[{request_id}] stats failure: {type(exc).__name__}: {exc}\n"
                )
                self.send_json(
                    {
                        "error": {
                            "code": "internal_error",
                            "message": "统计失败，请稍后重试",
                            "request_id": request_id,
                        }
                    },
                    status=500,
                    request_id=request_id,
                )
                return
            self.send_json(stats, request_id=request_id)
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            length = min(
                16_384, max(0, int(self.headers.get("Content-Length", "0")))
            )
            payload = (
                json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            )
            if not isinstance(payload, dict):
                raise ValueError("请求体必须是 JSON 对象")
            if parsed.path == "/api/app/ping":
                self.send_json({"ok": True})
                return
            if parsed.path == "/api/app/open-ui":
                opener = getattr(self.server, "open_ui", None)  # type: ignore[attr-defined]
                if opener is None:
                    raise RuntimeError("桌面前端入口不可用")
                result = opener()
                self.send_json({"ok": bool(result.get("opened")), "result": result})
                return
            if parsed.path == "/api/app/shutdown":
                expected = str(getattr(self.server, "takeover_token", ""))  # type: ignore[attr-defined]
                if not expected or str(payload.get("token") or "") != expected:
                    self.send_json({"ok": False, "error": "unauthorized"}, status=403)
                    return
                self.send_json({"ok": True, "stopping": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()  # type: ignore[attr-defined]
                return
            if parsed.path == "/api/app/startup":
                result = set_startup_enabled(bool(payload.get("enabled")))
                self.send_json({"ok": True, "result": result})
                return
            if parsed.path == "/api/app/quota-reset-exit":
                controller = getattr(self.server, "quota_reset_exit", None)  # type: ignore[attr-defined]
                if controller is None:
                    raise RuntimeError("额度重置退出控制器不可用")
                action = str(payload.get("action") or "").strip().lower()
                if action == "arm":
                    result = controller.arm(str(payload.get("cycle") or ""))
                elif action == "cancel":
                    result = controller.cancel()
                else:
                    raise ValueError("action 必须是 arm 或 cancel")
                self.send_json({"ok": True, "result": result})
                return
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            self.send_json({"ok": False, "error": str(error)}, status=400)
            return

        self.send_error(404)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def send_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(
        self,
        value: dict,
        *,
        status: int = 200,
        request_id: str | None = None,
    ) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if request_id:
            self.send_header("X-Request-ID", request_id)
        self.end_headers()
        self.wfile.write(body)


def parse_float(value: str, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_windows(value: str) -> list[int]:
    windows = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        multiplier = 1
        if part.lower().endswith("h"):
            multiplier = 60
            part = part[:-1]
        elif part.lower().endswith("m"):
            part = part[:-1]
        try:
            minutes = int(round(float(part) * multiplier))
        except ValueError:
            continue
        if 0 < minutes <= 1440 and minutes not in windows:
            windows.append(minutes)
    return windows or DEFAULT_WINDOWS


def warm_local_runtime(server: ThreadingHTTPServer) -> None:
    try:
        scan_lock = getattr(server, "local_metrics_scan_lock", None)
        if scan_lock is None:
            server.local_metrics.scan_once()  # type: ignore[attr-defined]
        else:
            with scan_lock:
                server.local_metrics.scan_once()  # type: ignore[attr-defined]
        server.local_metrics_last_scan_monotonic = time.monotonic()  # type: ignore[attr-defined]
        backfill_now = local_now()
        observations = collect_quota_observations(server.sessions_roots, backfill_now)  # type: ignore[attr-defined]
        server.quota_estimator.add_observations(observations, backfill_now)  # type: ignore[attr-defined]
        server.quota_history.backfill_sessions_once(observations, now=backfill_now)  # type: ignore[attr-defined]
        server.quota_history.maintain(backfill_now)  # type: ignore[attr-defined]
    except Exception as exc:
        sys.stderr.write(f"quota startup backfill failure: {type(exc).__name__}: {exc}\n")


def run_server(
    args: argparse.Namespace,
    *,
    on_ready: Callable[[], None] | None = None,
    on_server: Callable[[ThreadingHTTPServer], None] | None = None,
) -> None:
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    roots = getattr(args, "sessions_roots", None)
    if not roots:
        explicit = getattr(args, "sessions_root", None)
        roots = discover_session_roots(explicit)
    server.sessions_roots = normalize_session_roots(roots)
    server.sessions_root = server.sessions_roots[0]
    server.scan_hours = args.scan_hours
    initialize_persisted_stats_cache(server)
    server.periodic_stats_refresh_lock = threading.Lock()
    server.periodic_stats_refresh_target = None
    server.periodic_stats_refresh_stop_event = threading.Event()
    restore_periodic_stats_refresh_target(server)
    from dashboard_sync.local_runtime import LocalMetricsRuntime
    from dashboard_sync.quota_estimator import QuotaEstimator
    from dashboard_sync.quota_history import QuotaHistory

    server.local_metrics = LocalMetricsRuntime(server.sessions_root)
    server.local_metrics_scan_lock = threading.Lock()
    # The persisted store is immediately readable. Defer filesystem scanning so
    # the local HTTP server and the cached first paint are not blocked by it.
    server.local_metrics_last_scan_monotonic = time.monotonic()
    server.quota_history = QuotaHistory(server.local_metrics.store)
    server.quota_usage_provider = QuotaUsageProvider(server.sessions_roots)
    server.quota_estimator = QuotaEstimator(
        server.local_metrics.store,
        server.quota_usage_provider,
    )
    try:
        server.quota_history.import_led_history_once(now=local_now())
    except Exception as exc:
        sys.stderr.write(
            f"quota history LED import failure: {type(exc).__name__}: {exc}\n"
        )
    server.quota_reset_exit = QuotaResetExitController(
        lambda: cycle_windows_from_rate_limit_response(
            request_live_rate_limits(), local_now()
        ),
        close_codex_desktop,
    )
    server.quota_reset_exit.start()
    server.startup_warmup_thread = threading.Thread(  # type: ignore[attr-defined]
        target=warm_local_runtime,
        args=(server,),
        daemon=True,
        name="codex-dashboard-warmup",
    )
    server.startup_warmup_thread.start()  # type: ignore[attr-defined]
    server.periodic_stats_refresh_thread = threading.Thread(  # type: ignore[attr-defined]
        target=run_periodic_stats_refresh,
        args=(server,),
        daemon=True,
        name="codex-dashboard-periodic-refresh",
    )
    server.periodic_stats_refresh_thread.start()  # type: ignore[attr-defined]
    try:
        if on_server is not None:
            on_server(server)
        print(
            f"Serving Codex token speed dashboard at http://{args.host}:{args.port}/",
            flush=True,
        )
        if on_ready is not None:
            on_ready()
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.", flush=True)
    finally:
        server.periodic_stats_refresh_stop_event.set()
        server.quota_reset_exit.stop()
        server.local_metrics.close()
        server.server_close()


def main(
    argv: list[str] | None = None,
    *,
    on_ready: Callable[[], None] | None = None,
    on_server: Callable[[ThreadingHTTPServer], None] | None = None,
) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument(
        "--sessions-root",
        type=Path,
        action="append",
        default=[],
        help="additional Codex sessions root; may be repeated",
    )
    parser.add_argument("--preset", default="last_3h")
    parser.add_argument("--start", default=None)
    parser.add_argument("--end", default=None)
    parser.add_argument("--bucket", default=None, help="trend bucket minutes: auto, 1, 2, 5, 10, 15, 30, 60")
    parser.add_argument("--scan-hours", type=float, default=DEFAULT_SCAN_HOURS)
    parser.add_argument("--project", default="")
    parser.add_argument("--once", action="store_true", help="print JSON once and exit")
    args = parser.parse_args(argv)
    args.sessions_roots = discover_session_roots(args.sessions_root)
    args.sessions_root = args.sessions_roots[0]
    if args.once:
        stats = make_stats(
            args.sessions_roots,
            args.preset,
            args.start,
            args.end,
            args.scan_hours,
            args.project,
            args.bucket,
        )
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 0
    run_server(args, on_ready=on_ready, on_server=on_server)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
