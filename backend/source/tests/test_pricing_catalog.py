from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

import codex_token_speed_dashboard as dashboard
import pricing_catalog as pricing


API_DOC = """Prices per 1M tokens.
### Standard pricing data
| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Long context input | Long context output | Long context cached input |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-example | $4 | $10 | $0.40 | $5 | $8 | $15 | $0.80 |
### Batch pricing data
| Model | Input | Output | Cached input |
| gpt-example | $2 | $5 | $0.20 |
Short context: ≤272K input tokens. Long context: >272K input tokens.
"""
CREDIT_DOC = """Fast
| Model | Included usage | Credits / PAYG |
| GPT Example | 2.5x | 2x |
Ultrafast
<table>
<tr><th>Credits per 1M tokens</th><th>Input Tokens</th><th>Cached input tokens</th><th>Output Tokens</th></tr>
<tr><td>GPT Example</td><td>80 credits</td><td>8 credits</td><td>200 credits</td></tr>
</table>
"""
USAGE = {"input": 200_000, "cached": 160_000, "output": 20_000, "total": 220_000}


@pytest.mark.parametrize("model,cost,credits", [
    ("gpt-6.2-astra", 1.184, 29.6),
    ("gpt-6.2-sol", 0.296, 7.4),
    ("gpt-6.1-terra", 0.148, 3.7),
    ("gpt-6-luna", 0.0156, 0.39),
])
def test_new_models_have_offline_rates(model, cost, credits):
    result = dashboard.price_usage(USAGE, model)
    assert result["cost_base"] == pytest.approx(cost)
    assert result["credits"] == pytest.approx(credits)


def test_new_speed_rule_and_long_context_are_independent():
    arguments = dict(request_input=272_001, service_tier="ultrafast", cache_write_known=True)
    promotion = dashboard.price_usage(
        USAGE, "gpt-6.2-sol", timestamp=datetime(2027, 3, 1, 7, 59, tzinfo=timezone.utc), **arguments
    )
    regular = dashboard.price_usage(
        USAGE, "gpt-6.2-sol", timestamp=datetime(2027, 3, 1, 8, tzinfo=timezone.utc), **arguments
    )
    assert promotion["cost_base"] == pytest.approx(0.492)
    assert regular["cost_base"] == promotion["cost_base"]
    assert promotion["credits"] == pytest.approx(22.2)
    assert regular["credits"] == pytest.approx(44.4)


def test_sync_manual_override_and_last_good_disk_cache(monkeypatch, tmp_path):
    store = pricing.PricingCatalog(tmp_path / "pricing.json")
    monkeypatch.setattr(pricing, "catalog", store)
    monkeypatch.setattr(pricing, "local_labels", lambda: {"gpt-example": "GPT Example"})
    documents = {pricing.API_URL: API_DOC, pricing.CREDITS_URL: CREDIT_DOC}
    monkeypatch.setattr(pricing, "fetch_document", documents.__getitem__)
    before_key = dashboard.stats_cache_key(tmp_path, "today", None, None, 8, "")
    assert not dashboard.price_usage(USAGE, "gpt-example")["complete"]

    store.refresh(force=True)
    after_key = dashboard.stats_cache_key(tmp_path, "today", None, None, 8, "")
    assert before_key != after_key
    official = dashboard.price_usage(USAGE, "gpt-example", service_tier="fast")
    assert official["cost_base"] == pytest.approx(0.424)
    assert official["credits"] == pytest.approx(16.96)

    store.edit("GPT-EXAMPLE", {"label": "自定义名称", "input": 2, "cached": 0, "output": 5})
    documents[pricing.API_URL] = "changed document format"
    store.refresh(force=True)
    assert set(store.errors) == {"api"}
    assert store.snapshot.labels["gpt-example"] == "自定义名称"
    assert dashboard.price_usage(USAGE, "gpt-example")["cost_base"] == pytest.approx(0.18)
    restored = pricing.PricingCatalog(store.path)
    restored.load()
    assert restored.snapshot.revision == store.snapshot.revision
    assert restored.document["api"]["gpt-example"]["input"] == 4
    store.edit("gpt-example", {})
    assert dashboard.stats_cache_key(tmp_path, "today", None, None, 8, "") == after_key


def test_manual_http_edit_and_partial_credits(monkeypatch, tmp_path):
    store = pricing.PricingCatalog(tmp_path / "pricing.json")
    monkeypatch.setattr(pricing, "catalog", store)
    monkeypatch.setattr(dashboard, "catalog", store)
    with ThreadingHTTPServer(("127.0.0.1", 0), dashboard.DashboardHandler) as server:
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        def edit(values, *, origin=base):
            request = Request(
                base + "/api/model-pricing", data=json.dumps(values).encode(),
                headers={"Content-Type": "application/json", "Origin": origin},
            )
            with urlopen(request, timeout=2) as response:
                return json.load(response)
        try:
            payload = {
                "action": "save", "model": "future-model", "label": "手填模型",
                "input": 2, "cached": 0, "output": 5,
            }
            with pytest.raises(HTTPError) as denied:
                edit(payload, origin="https://example.com")
            assert denied.value.code == 403
            with pytest.raises(HTTPError) as invalid:
                edit({**payload, "output": None})
            assert invalid.value.code == 400
            assert edit(payload)["manual"]["future-model"]["cached"] == 0
            result = dashboard.price_usage(USAGE, "future-model")
            assert result["complete"] and not result["credits_complete"]
            assert result["cost_base"] == pytest.approx(0.18)
            assert result["unpriced_models"] == ["future-model (Credits)"]
            restored = edit({"action": "reset", "model": "future-model"})["manual"]
            assert restored["future-model"] == {"label": "手填模型"}
        finally:
            server.shutdown()
            thread.join()


def test_manual_name_for_known_alias_inherits_its_rates(monkeypatch, tmp_path):
    store = pricing.PricingCatalog(tmp_path / "pricing.json")
    monkeypatch.setattr(pricing, "catalog", store)
    before = dashboard.price_usage(USAGE, "gpt-5.6")
    store.edit("gpt-5.6", {"label": "Sol 自定义显示名"})
    after = dashboard.price_usage(USAGE, "gpt-5.6")
    assert after["cost_base"] == before["cost_base"]
    assert after["credits"] == before["credits"]
    assert store.snapshot.labels["gpt-5.6"] == "Sol 自定义显示名"
