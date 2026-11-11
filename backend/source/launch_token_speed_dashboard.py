#!/usr/bin/env python3
"""Windows launcher for one local agent and an on-demand native UI."""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
import secrets


HOST = "127.0.0.1"
SCAN_HOURS = "8"
WINDOW_TITLE = "Codex 用量监控"
AGENT_MUTEX_NAME = r"Local\CodexTokenDashboardAgentStableV1"
UI_MUTEX_NAME = r"Local\CodexTokenDashboardUIStableV1"
TAKEOVER_MUTEX_NAME = r"Local\CodexTokenDashboardTakeoverV1"
ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0 = 0
EXPECTED_APP_ID = "codex-token-dashboard"
EXPECTED_API_VERSION = 2
EXPECTED_STATS_ENGINE_VERSION = 4
PRODUCT_VERSION = 25
LOG_DIR = Path.home() / ".codex" / "logs"
OUT_LOG = LOG_DIR / "token_speed_dashboard-v6.out.log"
ERR_LOG = LOG_DIR / "token_speed_dashboard-v6.err.log"
PID_FILE = LOG_DIR / "token_speed_dashboard-agent.json"
STORAGE_DIR = Path.home() / ".codex" / "token-dashboard-webview"
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def ensure_streams() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if getattr(sys, "frozen", False):
        sys.stdout = OUT_LOG.open("a", encoding="utf-8", buffering=1)
        sys.stderr = ERR_LOG.open("a", encoding="utf-8", buffering=1)
        return
    if sys.stdout is None or not hasattr(sys.stdout, "write"):
        sys.stdout = OUT_LOG.open("a", encoding="utf-8", buffering=1)
    if sys.stderr is None or not hasattr(sys.stderr, "write"):
        sys.stderr = ERR_LOG.open("a", encoding="utf-8", buffering=1)


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel32.ReleaseMutex.restype = wintypes.BOOL
    return kernel32


def acquire_mutex(name: str) -> int | None:
    kernel32 = _kernel32()
    ctypes.set_last_error(0)
    handle = kernel32.CreateMutexW(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return None
    return int(handle)


def close_mutex(handle: int | None) -> None:
    if handle:
        _kernel32().CloseHandle(wintypes.HANDLE(handle))


def acquire_mutex_wait(name: str, timeout_ms: int = 10000) -> int:
    kernel32 = _kernel32()
    handle = kernel32.CreateMutexW(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if kernel32.WaitForSingleObject(handle, timeout_ms) != WAIT_OBJECT_0:
        kernel32.CloseHandle(handle)
        raise RuntimeError("等待版本接管锁超时")
    return int(handle)


def release_mutex(handle: int | None) -> None:
    if handle:
        kernel32 = _kernel32()
        kernel32.ReleaseMutex(wintypes.HANDLE(handle))
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def _user32():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowW.restype = wintypes.HWND
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    return user32


def focus_existing_window() -> bool:
    user32 = _user32()
    matches: list[int] = []
    @WNDENUMPROC
    def visit(hwnd: int, _lparam: int) -> bool:
        title_length = user32.GetWindowTextLengthW(hwnd)
        if title_length <= 0:
            return True
        title = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(hwnd, title, len(title))
        if title.value != WINDOW_TITLE:
            return True
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        if class_name.value.startswith("CodexTokenDashboardTray-"):
            return True
        matches.append(int(hwnd))
        return False

    user32.EnumWindows(visit, 0)
    if not matches:
        return False
    hwnd = wintypes.HWND(matches[0])
    user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    return True


def choose_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind((HOST, 0))
        return int(candidate.getsockname()[1])


def write_pid(port: int, takeover_token: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    temporary = PID_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "app_id": EXPECTED_APP_ID,
        "product_version": PRODUCT_VERSION,
        "pid": os.getpid(),
        "host": HOST,
        "port": port,
        "takeover_token": takeover_token,
        "executable": str(Path(sys.executable).resolve()),
        "started_at": time.time_ns(),
    }, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, PID_FILE)


def agent_health(port: int, timeout: float = 0.75) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/health", timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if not isinstance(value, dict):
        return None
    if value.get("app_id") != EXPECTED_APP_ID:
        return None
    if int(value.get("api_version", -1)) != EXPECTED_API_VERSION:
        return None
    if int(value.get("stats_engine_version", -1)) != EXPECTED_STATS_ENGINE_VERSION:
        return None
    return value


def read_agent_record() -> dict | None:
    try:
        value = json.loads(PID_FILE.read_text(encoding="utf-8"))
        port = int(value.get("port", 0))
        pid = int(value.get("pid", 0))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        PID_FILE.unlink(missing_ok=True)
        return None
    health = agent_health(port) if 1 <= port <= 65535 else None
    if not health or int(health.get("pid", -1)) != pid:
        PID_FILE.unlink(missing_ok=True)
        return None
    return {**value, "health": health}


def read_agent_port() -> int | None:
    record = read_agent_record()
    return int(record["port"]) if record else None


def wait_for_agent_port(timeout: float = 6.0) -> int | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        port = read_agent_port()
        if port is not None:
            return port
        time.sleep(0.15)
    return None


def resource_path(relative: str) -> Path:
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return root / relative


def child_command(*arguments: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *arguments]
    return [sys.executable, str(Path(__file__).resolve()), *arguments]


def child_environment() -> dict[str, str]:
    environment = os.environ.copy()
    if getattr(sys, "frozen", False):
        environment["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return environment


def dashboard_url(port: int, path: str = "/focus") -> str:
    return f"http://{HOST}:{port}{path}"


def open_browser(port: int) -> bool:
    return bool(webbrowser.open(dashboard_url(port)))


def post_port(port: int, path: str, payload: dict | None = None, timeout: float = 1.5) -> dict | None:
    if port is None:
        return None
    request = urllib.request.Request(
        f"http://{HOST}:{port}{path}",
        data=json.dumps(payload or {}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
            return value if isinstance(value, dict) else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def post_agent(path: str, payload: dict | None = None, timeout: float = 1.5) -> dict | None:
    port = read_agent_port()
    return post_port(port, path, payload, timeout) if port is not None else None


def windows_processes() -> list[dict]:
    if os.name != "nt":
        return []
    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);"
        "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | "
        "Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0 or not completed.stdout.strip():
            return []
        value = json.loads(completed.stdout)
        return value if isinstance(value, list) else [value]
    except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []


def kill_older_product_processes() -> list[int]:
    killed: list[int] = []
    # A portable launcher and its backend can have a localized Electron process between them.
    processes = windows_processes()
    parents = {
        int(process.get("ProcessId", 0) or 0): int(process.get("ParentProcessId", 0) or 0)
        for process in processes
    }
    protected = {os.getpid()}
    parent = parents.get(os.getpid())
    while parent and parent not in protected:
        protected.add(parent)
        parent = parents.get(parent)
    descendants = {os.getpid()}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in descendants and pid not in descendants:
                descendants.add(pid)
                protected.add(pid)
                changed = True
    for process in processes:
        name = str(process.get("Name") or "").casefold()
        if not (name.startswith("codextokendashboard") and name.endswith(".exe")):
            continue
        try:
            pid = int(process.get("ProcessId", 0))
        except (TypeError, ValueError):
            continue
        if pid <= 0 or pid in protected:
            continue
        result = subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode == 0:
            killed.append(pid)
    return killed


def stop_registered_agent(record: dict) -> None:
    token = str(record.get("takeover_token") or "")
    port = int(record.get("port", 0) or 0)
    if token and port:
        post_port(port, "/api/app/shutdown", {"token": token}, timeout=2.0)
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if agent_health(port, timeout=0.25) is None:
            return
        time.sleep(0.1)


class UIProcessManager:
    def __init__(self, port: int) -> None:
        self.port = port
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None

    def open(self) -> dict[str, object]:
        if focus_existing_window():
            return {"opened": True, "existing": True}
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return {"opened": True, "starting": True}
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._process = subprocess.Popen(
                child_command("--ui", "--port", str(self.port)),
                env=child_environment(),
                creationflags=creationflags,
                close_fds=True,
            )
            time.sleep(1.0)
            exit_code = self._process.poll()
            if exit_code is not None:
                opened = open_browser(self.port)
                return {
                    "opened": opened,
                    "fallback": "browser",
                    "ui_exit_code": exit_code,
                }
            return {"opened": True, "pid": self._process.pid}

    def close(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            process.terminate()


def run_agent(*, open_initial_ui: bool, mutex: int | None = None) -> int:
    mutex = mutex if mutex is not None else acquire_mutex(AGENT_MUTEX_NAME)
    if mutex is None:
        if open_initial_ui:
            port = wait_for_agent_port()
            if focus_existing_window() or (port is not None and post_agent("/api/app/open-ui")):
                return 0
            if port is not None and open_browser(port):
                return 0
            raise RuntimeError("已有后台实例，但无法打开其界面")
        return 0
    port = choose_port()
    takeover_token = secrets.token_urlsafe(24)
    manager = UIProcessManager(port)
    try:
        tool_dir = Path(__file__).resolve().parent
        sys.path.insert(0, str(tool_dir))
        import codex_token_speed_dashboard as dashboard

        def on_server(server: object) -> None:
            server.open_ui = manager.open  # type: ignore[attr-defined]
            server.takeover_token = takeover_token  # type: ignore[attr-defined]

        def on_ready() -> None:
            write_pid(port, takeover_token)
            if open_initial_ui:
                result = manager.open()
                if not result.get("opened"):
                    raise RuntimeError("本地服务已启动，但原生窗口和浏览器均无法打开")

        dashboard.main(
            ["--host", HOST, "--port", str(port), "--scan-hours", SCAN_HOURS],
            on_ready=on_ready,
            on_server=on_server,
        )
        return 0
    finally:
        manager.close()
        PID_FILE.unlink(missing_ok=True)
        close_mutex(mutex)


def run_ui(port: int) -> int:
    mutex = acquire_mutex(UI_MUTEX_NAME)
    if mutex is None:
        if not focus_existing_window():
            open_browser(port)
        return 0
    exit_requested = threading.Event()
    tray_holder: dict[str, object] = {}
    try:
        try:
            import webview
            from windows_tray import TrayIcon
        except Exception:
            traceback.print_exc(file=sys.stderr)
            if open_browser(port):
                return 0
            raise

        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        window = webview.create_window(
            WINDOW_TITLE,
            url=dashboard_url(port),
            width=1440,
            height=900,
            min_size=(960, 680),
            resizable=True,
            maximized=True,
            background_color="#FCFCFD",
            text_select=True,
            zoomable=False,
        )

        def show_window() -> None:
            window.show()

        def exit_ui() -> None:
            exit_requested.set()
            tray = tray_holder.get("tray")
            if tray is not None:
                tray.stop()  # type: ignore[attr-defined]
            window.destroy()

        def on_closing() -> bool | None:
            if exit_requested.is_set():
                return None
            window.hide()
            return False

        window.events.closing += on_closing
        tray = TrayIcon(
            resource_path("packaging/codex-token-dashboard.ico"),
            WINDOW_TITLE,
            on_open=show_window,
            on_exit=exit_ui,
        )
        tray_holder["tray"] = tray
        tray.start()
        icon = resource_path("packaging/codex-token-dashboard.ico")
        webview.start(
            gui="edgechromium",
            debug=False,
            private_mode=False,
            storage_path=str(STORAGE_DIR),
            icon=str(icon) if icon.exists() else None,
        )
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        if open_browser(port):
            return 0
        raise
    finally:
        tray = tray_holder.get("tray")
        if tray is not None:
            tray.stop()  # type: ignore[attr-defined]
        close_mutex(mutex)


def open_or_start_agent(*, background: bool) -> int:
    takeover = acquire_mutex_wait(TAKEOVER_MUTEX_NAME)
    agent_mutex: int | None = None
    try:
        record = read_agent_record()
        if record:
            existing_version = int((record.get("health") or {}).get("product_version", record.get("product_version", 0)) or 0)
            if existing_version >= PRODUCT_VERSION:
                response = post_port(int(record["port"]), "/api/app/open-ui" if not background else "/api/app/ping")
                if response and response.get("ok") is not False:
                    return 0
            else:
                stop_registered_agent(record)
        kill_older_product_processes()
        PID_FILE.unlink(missing_ok=True)
        agent_mutex = acquire_mutex(AGENT_MUTEX_NAME)
        if agent_mutex is None:
            port = wait_for_agent_port()
            if port is not None:
                response = post_agent("/api/app/open-ui" if not background else "/api/app/ping")
                if response and response.get("ok") is not False:
                    return 0
            raise RuntimeError("已有后台实例，但无法完成版本接管")
    finally:
        release_mutex(takeover)
    return run_agent(open_initial_ui=not background, mutex=agent_mutex)


def show_error(message: str) -> None:
    if os.name != "nt":
        return
    try:
        ctypes.windll.user32.MessageBoxW(None, message, WINDOW_TITLE, 0x10)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    ensure_streams()
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--agent", action="store_true")
    parser.add_argument("--background", action="store_true")
    parser.add_argument("--ui", action="store_true")
    parser.add_argument("--port", type=int)
    args, _unknown = parser.parse_known_args(argv)
    if args.ui:
        if not args.port:
            return 2
        return run_ui(args.port)
    if args.agent:
        return run_agent(open_initial_ui=not args.background)
    return open_or_start_agent(background=args.background)


def run_safely(argv: list[str] | None = None) -> int:
    try:
        return main(argv)
    except Exception as error:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with ERR_LOG.open("a", encoding="utf-8") as handle:
            traceback.print_exc(file=handle)
        message = f"启动失败：{error}\n\n详细日志：{ERR_LOG}"
        show_error(message)
        return 1


if __name__ == "__main__":
    raise SystemExit(run_safely())
