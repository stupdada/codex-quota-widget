"""Validated local pricing catalog and official OpenAI rate sources."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import urlopen

# Official OpenAI API text-token pricing, USD per 1M tokens.
# Sol rates and Fast credits checked 2026-10-09:
# https://developers.openai.com/api/docs/pricing
# Credits: https://developers.openai.com/codex/pricing
# Fast credits: https://learn.chatgpt.com/docs/agent-configuration/speed
BUILTIN_PROFILES = {
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

API_URL = "https://developers.openai.com/api/docs/pricing.md"
CREDITS_URL = "https://learn.chatgpt.com/docs/pricing.md"
USD_FIELDS = ("input", "cached", "output")
CREDIT_FIELDS = ("credits_input", "credits_cached", "credits_output")
MODEL_ID = re.compile(r"[a-z0-9][a-z0-9_.:/-]{0,159}")
DAILY = 86_400
LONG_INPUT = 272_000
ULTRA_LIST_RATE_START = datetime(2027, 3, 1, 8, tzinfo=timezone.utc)
MAX_DOCUMENT = 512 * 1024
EMPTY_PROFILE = dict.fromkeys((*USD_FIELDS, *CREDIT_FIELDS))
EMPTY_PROFILE.update(cache_write_multiplier=1.0, fast_credit_multiplier=None)

for model, label, usd, credits in (
    ("gpt-6.2-astra", "GPT-6.2 Astra", (8, 0.4, 40), (200, 10, 1_000)),
    ("gpt-6.2-sol", "GPT-6.2 Sol", (2, 0.1, 10), (50, 2.5, 250)),
    ("gpt-6.1-terra", "GPT-6.1 Terra", (1, 0.05, 5), (25, 1.25, 125)),
    ("gpt-6-luna", "GPT-6 Luna", (0.1, 0.01, 0.5), (2.5, 0.25, 12.5)),
):
    BUILTIN_PROFILES[model] = {
        "label": label,
        **dict(zip(USD_FIELDS, usd)),
        **dict(zip(CREDIT_FIELDS, credits)),
        "cache_write_multiplier": 1.25,
        "fast_credit_multiplier": 2.0,
        "long_input_threshold": LONG_INPUT,
        "long_rates": (2 * usd[0], 2 * usd[1], 1.5 * usd[2]),
    }

for model in ("gpt-6.2-sol", "gpt-6.2-astra"):
    BUILTIN_PROFILES[model]["ultrafast_credits"] = (3.0, ULTRA_LIST_RATE_START.isoformat(), 6.0)


def numeric_rate(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("费率必须是数字")
    if not 0 <= value <= 1_000_000 or not math.isfinite(value):
        raise ValueError("费率必须在 0 到 1,000,000 之间")
    return float(value)


def dollars(cell: str) -> float:
    if not re.fullmatch(r"\$\d+(?:,\d{3})*(?:\.\d+)?", cell):
        raise ValueError("无法识别美元费率")
    return numeric_rate(float(cell[1:].replace(",", "")))


def markdown_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_api_pricing(document: str) -> dict:
    prefix, heading, tail = document.partition("### Standard pricing data\n")
    if not heading or "Prices per 1M tokens." not in prefix:
        raise ValueError("官方 API 价表格式已变化")
    section = tail.split("\n### ", 1)[0]
    threshold = re.search(
        r"Short context: ≤([\d,]+)(K?) input tokens\. Long context: >\1\2 input tokens",
        document,
    )
    long_threshold = None
    if threshold:
        long_threshold = int(threshold[1].replace(",", "")) * (1000 if threshold[2] else 1)

    profiles = {}
    columns = []
    for line in section.splitlines():
        if not line.startswith("|"):
            continue
        cells = markdown_row(line)
        if cells[0] == "Model":
            columns = cells
            continue
        model = cells[0]
        if not MODEL_ID.fullmatch(model):
            continue
        if not columns or len(cells) != len(columns) or model in profiles:
            raise ValueError("官方 API 价表模型行异常")
        row = dict(zip(columns, cells))
        short_prefix = "Short context " if "Short context input" in row else ""
        names = ("input", "cached input", "output")
        # The compact table uses title-cased headers.
        rates = [row[short_prefix + name if short_prefix else name.capitalize()] for name in names]
        if "-" in rates:
            continue
        profile = dict(zip(USD_FIELDS, map(dollars, rates)))
        write_rate = row.get("Short context 30m write")
        if write_rate and write_rate != "-" and profile["input"]:
            profile["cache_write_multiplier"] = dollars(write_rate) / profile["input"]
        long_rates = [row.get("Long context " + name) for name in names]
        if long_threshold and all(value and value != "-" for value in long_rates):
            profile["long_input_threshold"] = long_threshold
            profile["long_rates"] = [dollars(value) for value in long_rates]
        profiles[model] = profile
    if not profiles:
        raise ValueError("官方 API 价表缺少有效费率")
    return profiles


class CreditTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.rows = None
        self.cells = None
        self.cell = None

    def handle_starttag(self, tag, _attrs):
        if tag == "table":
            self.rows = []
        elif self.rows is not None and tag == "tr":
            self.cells = []
        elif self.cells is not None and tag in ("th", "td"):
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("th", "td") and self.cell is not None:
            self.cells.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.cells is not None:
            self.rows.append(self.cells)
            self.cells = None
        elif tag == "table" and self.rows is not None:
            self.tables.append(self.rows)
            self.rows = None


def parse_credit_pricing(document: str) -> dict:
    parser = CreditTable()
    parser.feed(document)
    header = ["credits per 1m tokens", "input tokens", "cached input tokens", "output tokens"]
    tables = [rows for rows in parser.tables if rows and [cell.casefold() for cell in rows[0]] == header]
    if not tables:
        rows = []
        for line in document.splitlines():
            if not line.startswith("|"):
                if rows:
                    break
                continue
            cells = markdown_row(line)
            if [cell.casefold() for cell in cells] == header:
                rows = [cells]
            elif rows and not all(re.fullmatch(r"[-:\s]+", cell) for cell in cells):
                rows.append(cells)
        if rows:
            tables.append(rows)
    if len(tables) != 1:
        raise ValueError("官方 Credits 价表格式已变化")
    profiles = {}
    for row in tables[0][1:]:
        if len(row) == 1:  # Footnotes span the table.
            continue
        if len(row) != 4 or row[0] in profiles:
            raise ValueError("官方 Credits 价表模型行异常")
        rates = []
        for cell in row[1:]:
            match = re.fullmatch(r"(\d+(?:,\d{3})*(?:\.\d+)?) credits?", cell)
            if not match:
                raise ValueError("无法识别 Credits 费率")
            rates.append(numeric_rate(float(match[1].replace(",", ""))))
        profiles[row[0]] = dict(zip(CREDIT_FIELDS, rates))
    if not profiles:
        raise ValueError("官方 Credits 价表缺少有效费率")
    fast = re.search(r"^Fast\s*\n(.*?)^Ultrafast\s*$", document, re.MULTILINE | re.DOTALL)
    if fast:
        for line in fast[1].splitlines():
            if not line.startswith("|"):
                continue
            cells = markdown_row(line)
            if len(cells) != 3 or not re.fullmatch(r"[\d.]+x", cells[-1]):
                continue
            multiplier = numeric_rate(float(cells[-1][:-1]))
            for name in re.split(r"<br\s*/?>", cells[0]):
                if name.strip() in profiles:
                    profiles[name.strip()]["fast_credit_multiplier"] = multiplier
    return profiles


def fetch_document(url: str) -> str:
    with urlopen(url, timeout=8) as response:
        if response.geturl() != url:
            raise ValueError("官方价表地址已变化")
        body = response.read(MAX_DOCUMENT + 1)
    if len(body) > MAX_DOCUMENT:
        raise ValueError("官方价表超过大小限制")
    return body.decode("utf-8")


def local_labels() -> dict[str, str]:
    root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    try:
        with (root / "models_cache.json").open("rb") as stream:
            payload = json.loads(stream.read(4 * 1024 * 1024))
        models = payload.get("models", [])
        return {
            row["slug"].lower(): row["display_name"]
            for row in models if isinstance(row, dict)
            and isinstance(row.get("slug"), str) and MODEL_ID.fullmatch(row["slug"].lower())
            and isinstance(row.get("display_name"), str) and 0 < len(row["display_name"]) <= 120
        }
    except (OSError, ValueError, AttributeError, TypeError):
        return {}


def pricing_path() -> Path:
    roaming = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    return roaming / "codex-token-dashboard" / "model-pricing.json"


def normalized_name(name: str) -> str:
    return re.sub(r"[\s-]+", "-", name.strip().lower())


def manual_profile(value: dict) -> dict:
    label = value.get("label", "")
    if not isinstance(label, str) or len(label) > 120:
        raise ValueError("显示名最多 120 个字符")
    profile = {"label": label.strip()} if label.strip() else {}
    for fields in (USD_FIELDS, CREDIT_FIELDS):
        rates = [value.get(field) for field in fields]
        if any(rate is not None for rate in rates):
            if any(rate is None for rate in rates):
                raise ValueError("请填完整组费率，或留空整组")
            profile.update(zip(fields, map(numeric_rate, rates)))
    return profile


@dataclass(frozen=True)
class Snapshot:
    profiles: dict
    labels: dict
    revision: str


class PricingCatalog:
    def __init__(self, path: Path | None = None):
        self.path = path
        self.lock = threading.Lock()
        self.refresh_lock = threading.Lock()
        self.document = {"api": {}, "credits": {}, "manual": {}, "synced": {}}
        self.labels = {}
        self.errors = {}
        self.last_attempt = None
        self.snapshot = self.build_snapshot(self.document)

    def build_snapshot(self, document: dict) -> Snapshot:
        profiles = {model: dict(profile) for model, profile in BUILTIN_PROFILES.items()}
        labels = {model: profile["label"] for model, profile in profiles.items()} | self.labels
        for model, rates in document["api"].items():
            profile = profiles.setdefault(model, dict(EMPTY_PROFILE))
            profile.update(rates)
        matches = {}
        for model in set(profiles) | set(labels):
            for name in (model, labels.get(model, model)):
                matches.setdefault(normalized_name(name), set()).add(model)
        for name, rates in document["credits"].items():
            models = matches.get(normalized_name(name), ())
            if len(models) == 1:
                model = next(iter(models))
                profiles.setdefault(model, dict(EMPTY_PROFILE)).update(rates)
        for model in sorted(document["manual"], key=MODEL_ALIASES.__contains__):
            manual = document["manual"][model]
            base = profiles.get(MODEL_ALIASES.get(model), EMPTY_PROFILE)
            profile = profiles.setdefault(model, dict(base))
            profile.update({key: value for key, value in manual.items() if key != "label"})
            if "label" in manual:
                labels[model] = manual["label"]
            if "input" in manual:
                profile.pop("long_rates", None)
        for model, profile in profiles.items():
            profile["label"] = labels.get(model, model)
        content = json.dumps([profiles, labels], sort_keys=True, allow_nan=False)
        return Snapshot(profiles, labels, hashlib.sha256(content.encode()).hexdigest()[:24])

    def load(self) -> None:
        self.path = self.path or pricing_path()
        self.labels = local_labels()
        try:
            content = json.loads(self.path.read_text(encoding="utf-8"))
            if content["version"] != 1:
                raise ValueError("无法识别本地价表版本")
            candidate = {key: content[key] for key in self.document}
            if any(not isinstance(value, dict) for value in candidate.values()):
                raise ValueError("本地价表结构无效")
            if any(type(value) is not int for value in candidate["synced"].values()):
                raise ValueError("本地价表同步时间无效")
            candidate["manual"] = {
                model: manual_profile(value)
                for model, value in candidate["manual"].items()
                if MODEL_ID.fullmatch(model)
            }
            snapshot = self.build_snapshot(candidate)
        except FileNotFoundError:
            self.snapshot = self.build_snapshot(self.document)
        except (OSError, ValueError, AttributeError, KeyError, TypeError):
            self.errors["local"] = "本地价表暂不可读"
            self.snapshot = self.build_snapshot(self.document)
        else:
            self.document = candidate
            self.snapshot = snapshot

    def commit(self, candidate: dict) -> None:
        snapshot = self.build_snapshot(candidate)
        if candidate != self.document:
            path = self.path or pricing_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
                    temp_path = Path(stream.name)
                    json.dump({"version": 1, **candidate}, stream, ensure_ascii=False, indent=2, allow_nan=False)
                os.replace(temp_path, path)
            finally:
                if temp_path is not None:
                    temp_path.unlink(missing_ok=True)
        self.document = candidate
        self.snapshot = snapshot

    def edit(self, model: str, value: dict, *, keep_label: bool = False) -> None:
        model = model.strip().lower()
        if not MODEL_ID.fullmatch(model):
            raise ValueError("请输入会话日志里的有效模型 ID")
        profile = manual_profile(value)
        with self.lock:
            manual = dict(self.document["manual"])
            if keep_label and "label" in manual.get(model, {}):
                profile["label"] = manual[model]["label"]
            if profile:
                manual[model] = profile
            else:
                manual.pop(model, None)
            self.commit({**self.document, "manual": manual})

    def refresh(self, *, force: bool = False) -> None:
        if not self.refresh_lock.acquire(blocking=False):
            if force:
                with self.refresh_lock:
                    pass
            return
        try:
            now = time.time()
            if not force and self.last_attempt is not None and now - self.last_attempt < DAILY:
                return
            self.last_attempt = now
            sources = {}
            failures = {}
            for key, url, parser in (
                ("api", API_URL, parse_api_pricing),
                ("credits", CREDITS_URL, parse_credit_pricing),
            ):
                try:
                    sources[key] = parser(fetch_document(url))
                except (OSError, ValueError, KeyError):
                    failures[key] = "暂未同步，继续使用已有费率"
            with self.lock:
                self.labels = local_labels() or self.labels
                candidate = dict(self.document)
                synced = dict(candidate["synced"])
                for key, updates in sources.items():
                    candidate[key] = {**candidate[key], **updates}
                    synced[key] = int(now)
                candidate["synced"] = synced
                self.commit(candidate)
                self.errors = failures
        finally:
            self.refresh_lock.release()

    def settings(self) -> dict:
        with self.lock:
            return {
                "revision": self.snapshot.revision,
                "profiles": self.snapshot.profiles,
                "labels": self.snapshot.labels,
                "manual": self.document["manual"],
                "synced": self.document["synced"],
                "errors": self.errors,
            }


catalog = PricingCatalog()
_snapshot = ContextVar("pricing_snapshot", default=None)


def active_snapshot() -> Snapshot:
    return _snapshot.get() or catalog.snapshot


def with_pricing_snapshot(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if _snapshot.get() is not None:
            return fn(*args, **kwargs)
        token = _snapshot.set(catalog.snapshot)
        try:
            return fn(*args, **kwargs)
        finally:
            _snapshot.reset(token)
    return wrapped
