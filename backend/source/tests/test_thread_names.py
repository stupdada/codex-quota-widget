import json
import threading
from copy import deepcopy
from urllib.request import urlopen

import codex_token_speed_dashboard as dashboard
import launch_token_speed_dashboard as launcher


def test_backend_and_launcher_advertise_the_same_product_version():
    assert dashboard.health_payload()["product_version"] == launcher.PRODUCT_VERSION


def test_stats_routes_lookup_current_thread_names_for_cached_rows(monkeypatch, tmp_path):
    root = tmp_path / "sessions"
    root.mkdir()
    index = tmp_path / "session_index.jsonl"
    thread_id = "01a21b70-example"
    thread = {"thread_id": thread_id, "short_thread": "01a21b70"}
    unnamed = {"thread_id": "01a206fb-example", "short_thread": "01a206fb"}
    stats = {
        "thread_top": [{**thread, "members": [thread.copy(), unnamed]}],
        "latest": [thread.copy()],
    }
    original = {"id": thread_id, "thread_name": "旧标题"}
    index.write_text(json.dumps(original, ensure_ascii=False) + "\n", encoding="utf-8")

    with dashboard.ThreadingHTTPServer(("127.0.0.1", 0), dashboard.DashboardHandler) as server:
        server.sessions_root = root
        server.sessions_roots = [root]
        server.scan_hours = 8
        monkeypatch.setattr(dashboard, "make_api_stats", lambda *args, **kwargs: deepcopy(stats))
        dashboard.initialize_persisted_stats_cache(server, tmp_path / "stats-cache.json")
        key = dashboard.stats_cache_key(root, "last_3h", None, None, 8, "", None)
        dashboard.remember_persisted_stats(server, key, stats)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/api"
            with urlopen(f"{url}/stats", timeout=5) as response:
                assert json.load(response)["thread_top"][0]["thread_name"] == "旧标题"

            new_title = "新标题 · <示例>"
            renamed = {"id": thread_id, "thread_name": new_title}
            with index.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(renamed, ensure_ascii=False) + "\n")
                handle.write('{"id":')
            with urlopen(f"{url}/stats-cache", timeout=5) as response:
                cached = json.load(response)
            family = cached["thread_top"][0]
            assert family["thread_name"] == new_title
            assert family["thread_id"] == thread_id
            assert family["members"][0]["thread_name"] == new_title
            assert family["members"][1] == unnamed
            assert cached["latest"][0]["thread_name"] == new_title
            assert "thread_name" not in stats["thread_top"][0]
        finally:
            server.shutdown()
            worker.join(timeout=5)
