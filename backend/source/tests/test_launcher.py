from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "source_dashboard_launcher", ROOT / "launch_token_speed_dashboard.py"
)
assert SPEC and SPEC.loader
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def test_read_agent_port_rejects_stale_or_foreign_health(tmp_path: Path) -> None:
    pid_file = tmp_path / "agent.pid"
    pid_file.write_text(json.dumps({"pid": 123, "port": 54321}), encoding="utf-8")
    with patch.object(launcher, "PID_FILE", pid_file), patch.object(
        launcher, "agent_health", return_value=None
    ):
        assert launcher.read_agent_port() is None
    assert not pid_file.exists()


def test_read_agent_port_accepts_only_expected_app_identity(tmp_path: Path) -> None:
    pid_file = tmp_path / "agent.pid"
    pid_file.write_text(json.dumps({"pid": 123, "port": 54321}), encoding="utf-8")
    health = {
        "app_id": "codex-token-dashboard",
        "api_version": 2,
        "stats_engine_version": 3,
        "pid": 123,
        "product_version": launcher.PRODUCT_VERSION,
    }
    with patch.object(launcher, "PID_FILE", pid_file), patch.object(
        launcher, "agent_health", return_value=health
    ):
        assert launcher.read_agent_port() == 54321


def test_newer_registered_agent_is_reused_without_aoe(tmp_path: Path) -> None:
    record = {
        "pid": 123,
        "port": 54321,
        "product_version": launcher.PRODUCT_VERSION + 1,
        "health": {"product_version": launcher.PRODUCT_VERSION + 1},
    }
    with patch.object(launcher, "acquire_mutex_wait", return_value=11), patch.object(
        launcher, "release_mutex"
    ), patch.object(launcher, "read_agent_record", return_value=record), patch.object(
        launcher, "post_port", return_value={"ok": True}
    ), patch.object(launcher, "kill_older_product_processes") as kill:
        assert launcher.open_or_start_agent(background=False) == 0
    kill.assert_not_called()


def test_current_version_aoe_kills_legacy_product_processes(tmp_path: Path) -> None:
    with patch.object(launcher, "acquire_mutex_wait", return_value=11), patch.object(
        launcher, "release_mutex"
    ), patch.object(launcher, "read_agent_record", return_value=None), patch.object(
        launcher, "kill_older_product_processes", return_value=[10, 20]
    ) as kill, patch.object(launcher, "acquire_mutex", return_value=22), patch.object(
        launcher, "run_agent", return_value=0
    ) as run, patch.object(launcher, "PID_FILE", tmp_path / "agent.json"):
        assert launcher.open_or_start_agent(background=True) == 0
    kill.assert_called_once()
    run.assert_called_once_with(open_initial_ui=False, mutex=22)


def test_aoe_protects_pyinstaller_parent_and_child_processes() -> None:
    current = launcher.os.getpid()
    processes = [
        {"ProcessId": current - 1, "ParentProcessId": 4, "Name": "CodexTokenDashboard.exe"},
        {"ProcessId": current, "ParentProcessId": current - 1, "Name": "CodexTokenDashboard.exe"},
        {"ProcessId": current + 1, "ParentProcessId": current, "Name": "CodexTokenDashboard.exe"},
        {"ProcessId": 99999, "ParentProcessId": 4, "Name": "CodexTokenDashboard(7).exe"},
    ]
    completed = Mock(returncode=0)
    with patch.object(launcher, "dashboard_processes", return_value=processes), patch.object(
        launcher.subprocess, "run", return_value=completed
    ) as run:
        assert launcher.kill_older_product_processes() == [99999]
    assert run.call_args.args[0][2] == "99999"


class _ExitedProcess:
    pid = 77

    @staticmethod
    def poll() -> int:
        return 1


def test_ui_child_early_exit_falls_back_to_browser() -> None:
    manager = launcher.UIProcessManager(54321)
    with patch.object(launcher, "focus_existing_window", return_value=False), patch.object(
        launcher.subprocess, "Popen", return_value=_ExitedProcess()
    ), patch.object(launcher.time, "sleep"), patch.object(
        launcher.webbrowser, "open", return_value=True
    ) as open_browser:
        result = manager.open()
    assert result["opened"] is True
    assert result["fallback"] == "browser"
    open_browser.assert_called_once_with("http://127.0.0.1:54321/focus")


def test_interactive_failure_is_logged_and_returns_nonzero(tmp_path: Path) -> None:
    error_log = tmp_path / "launcher.err.log"
    with patch.object(launcher, "ERR_LOG", error_log), patch.object(
        launcher, "main", side_effect=RuntimeError("boom")
    ), patch.object(launcher, "show_error") as show_error:
        result = launcher.run_safely([])
    assert result == 1
    assert "RuntimeError: boom" in error_log.read_text(encoding="utf-8")
    show_error.assert_called_once()


def test_launcher_declares_pointer_sized_win32_handles() -> None:
    source = (ROOT / "launch_token_speed_dashboard.py").read_text(encoding="utf-8")
    assert "restype = wintypes.HANDLE" in source
    assert "argtypes = [wintypes.HANDLE]" in source
    assert "EnumWindows" in source
    tray_source = (ROOT / "windows_tray.py").read_text(encoding="utf-8")
    assert 'f"{self.title} Tray"' in tray_source
