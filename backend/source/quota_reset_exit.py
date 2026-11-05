from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path


CYCLE_LABELS = {"five_hour": "5h", "weekly": "7d"}
DEFAULT_STATE_PATH = Path.home() / ".codex" / "token-dashboard" / "quota-reset-exit.json"
DEFAULT_LOG_PATH = Path.home() / ".codex" / "logs" / "token-dashboard-reset-exit.jsonl"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _number(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _reset_confirmation_signature(baseline: dict, snapshot: dict) -> str:
    old_used = _number(baseline.get("used_percent"))
    new_used = _number(snapshot.get("used_percent"))
    if (
        old_used is not None
        and new_used is not None
        and old_used >= 10
        and new_used <= max(10.0, old_used * 0.25)
    ):
        return "usage-reset"
    return "window-reset"


def reset_detected(baseline: dict, current: dict) -> bool:
    old_reset = baseline.get("reset")
    new_reset = current.get("reset")
    if old_reset and new_reset and old_reset != new_reset:
        return True
    old_used = _number(baseline.get("used_percent"))
    new_used = _number(current.get("used_percent"))
    if old_used is None or new_used is None or old_used < 10:
        return False
    return new_used <= max(10.0, old_used * 0.25)


class QuotaResetExitController:
    def __init__(
        self,
        cycle_reader: Callable[[], dict[str, dict | None]],
        desktop_exit: Callable[[], dict],
        *,
        state_path: Path = DEFAULT_STATE_PATH,
        log_path: Path = DEFAULT_LOG_PATH,
        poll_seconds: float = 15.0,
    ) -> None:
        self.cycle_reader = cycle_reader
        self.desktop_exit = desktop_exit
        self.state_path = state_path
        self.log_path = log_path
        self.poll_seconds = max(1.0, float(poll_seconds))
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = self._load_state()

    def _default_state(self) -> dict:
        return {
            "schema_version": 1,
            "armed": False,
            "phase": "idle",
            "cycle": None,
            "baseline": None,
            "armed_at": None,
            "last_checked_at": None,
            "last_snapshot": None,
            "available": {"five_hour": False, "weekly": False},
            "candidate_signature": None,
            "confirmation_count": 0,
            "trigger_confirmed": False,
            "triggered_at": None,
            "completed_at": None,
            "close_result": None,
            "error": None,
        }

    def _load_state(self) -> dict:
        state = self._default_state()
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return state
        if not isinstance(saved, dict):
            return state
        state.update(saved)
        if state.get("cycle") not in CYCLE_LABELS:
            state.update(self._default_state())
        return state

    def _save_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(self._state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, self.state_path)

    def _log(self, event: str, **values: object) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        row = {"timestamp": _now_iso(), "event": event, **values}
        with self.log_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

    def _public_locked(self) -> dict:
        value = dict(self._state)
        cycle = value.get("cycle")
        value["cycle_label"] = CYCLE_LABELS.get(str(cycle), None)
        value["poll_seconds"] = self.poll_seconds
        value["state_path"] = str(self.state_path)
        value["log_path"] = str(self.log_path)
        return value

    def _read_direct(self) -> dict[str, dict | None]:
        cycles = self.cycle_reader()
        if not isinstance(cycles, dict):
            raise ValueError("Codex 直接额度接口返回无效数据")
        with self._lock:
            self._state["available"] = {
                name: isinstance(cycles.get(name), dict) for name in CYCLE_LABELS
            }
            self._state["last_checked_at"] = _now_iso()
            self._save_locked()
        return cycles

    def status(self, *, refresh: bool = False) -> dict:
        if refresh:
            try:
                if self.is_armed():
                    self.poll_once()
                else:
                    cycles = self._read_direct()
                    with self._lock:
                        self._state["last_snapshot"] = {
                            name: cycles.get(name) for name in CYCLE_LABELS
                        }
                        self._state["error"] = None
                        self._save_locked()
            except (OSError, RuntimeError, TimeoutError, ValueError) as error:
                with self._lock:
                    self._state["error"] = f"直接额度读取失败：{error}"
                    self._save_locked()
        with self._lock:
            return self._public_locked()

    def is_armed(self) -> bool:
        with self._lock:
            return bool(self._state.get("armed"))

    def arm(self, cycle: str) -> dict:
        if cycle not in CYCLE_LABELS:
            raise ValueError("周期必须是 five_hour 或 weekly")
        cycles = self._read_direct()
        baseline = cycles.get(cycle)
        if not isinstance(baseline, dict):
            raise ValueError(f"当前没有可用的 {CYCLE_LABELS[cycle]} 额度数据")
        with self._lock:
            available = dict(self._state.get("available") or {})
            self._state = self._default_state()
            self._state.update(
                {
                    "armed": True,
                    "phase": "armed",
                    "cycle": cycle,
                    "baseline": baseline,
                    "armed_at": _now_iso(),
                    "last_checked_at": _now_iso(),
                    "last_snapshot": baseline,
                    "available": available,
                }
            )
            self._save_locked()
            result = self._public_locked()
        self._log("armed", cycle=cycle, baseline=baseline)
        return result

    def cancel(self) -> dict:
        with self._lock:
            previous = self._public_locked()
            available = dict(self._state.get("available") or {})
            self._state = self._default_state()
            self._state["available"] = available
            self._state["phase"] = "cancelled"
            self._save_locked()
            result = self._public_locked()
        self._log("cancelled", previous_cycle=previous.get("cycle"))
        return result

    def poll_once(self) -> dict:
        with self._lock:
            if not self._state.get("armed"):
                return self._public_locked()
            trigger_confirmed = bool(self._state.get("trigger_confirmed"))
            cycle = str(self._state.get("cycle"))
            baseline = self._state.get("baseline")
        if trigger_confirmed:
            return self._attempt_close()
        try:
            cycles = self._read_direct()
            current = cycles.get(cycle)
            if not isinstance(current, dict):
                raise ValueError(f"直接接口暂时没有 {CYCLE_LABELS.get(cycle, cycle)} 额度")
            with self._lock:
                self._state["last_snapshot"] = current
                self._state["error"] = None
                if isinstance(baseline, dict) and reset_detected(baseline, current):
                    signature = _reset_confirmation_signature(baseline, current)
                    if signature == self._state.get("candidate_signature"):
                        self._state["confirmation_count"] = int(
                            self._state.get("confirmation_count") or 0
                        ) + 1
                    else:
                        self._state["candidate_signature"] = signature
                        self._state["confirmation_count"] = 1
                    if int(self._state["confirmation_count"]) >= 2:
                        self._state["trigger_confirmed"] = True
                        self._state["phase"] = "closing"
                        self._state["triggered_at"] = _now_iso()
                else:
                    self._state["candidate_signature"] = None
                    self._state["confirmation_count"] = 0
                should_close = bool(self._state.get("trigger_confirmed"))
                self._save_locked()
                result = self._public_locked()
            if should_close:
                self._log("reset_confirmed", cycle=cycle, baseline=baseline, current=current)
                return self._attempt_close()
            return result
        except (OSError, RuntimeError, TimeoutError, ValueError) as error:
            with self._lock:
                self._state["error"] = f"直接检测失败，将自动重试：{error}"
                self._state["phase"] = "armed"
                self._save_locked()
                return self._public_locked()

    def _attempt_close(self) -> dict:
        try:
            close_result = self.desktop_exit()
            success = bool(close_result.get("success"))
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            close_result = {"success": False, "error": str(error)}
            success = False
        with self._lock:
            self._state["close_result"] = close_result
            if success:
                self._state["armed"] = False
                self._state["phase"] = "completed"
                self._state["completed_at"] = _now_iso()
                self._state["error"] = None
            else:
                self._state["armed"] = True
                self._state["phase"] = "retry_close"
                self._state["error"] = str(
                    close_result.get("error") or "Codex Desktop 尚未退出，将自动重试"
                )
            self._save_locked()
            result = self._public_locked()
        self._log("desktop_close_result", result=close_result, success=success)
        return result

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="quota-reset-exit-watcher",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            if self.is_armed():
                self.poll_once()
            self._stop.wait(self.poll_seconds)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)


def _powershell_executable() -> str:
    return shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"


def list_codex_desktop_processes() -> list[dict]:
    if os.name != "nt":
        return []
    script = (
        "$p=Get-CimInstance Win32_Process | Where-Object { "
        "$_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' };"
        "$p | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        [_powershell_executable(), "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "无法枚举 Codex Desktop 进程")
    text = completed.stdout.strip()
    if not text:
        return []
    value = json.loads(text)
    return value if isinstance(value, list) else [value]


def close_codex_desktop() -> dict:
    processes = list_codex_desktop_processes()
    if not processes:
        return {"success": False, "error": "未找到正在运行的 Codex Desktop", "target_pids": []}
    ids = {int(item.get("ProcessId") or 0) for item in processes}
    roots = [
        int(item.get("ProcessId") or 0)
        for item in processes
        if int(item.get("ParentProcessId") or 0) not in ids
    ]
    target_pids = [pid for pid in roots if pid > 0] or sorted(pid for pid in ids if pid > 0)
    results = []
    for pid in target_pids:
        completed = subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        results.append({"pid": pid, "returncode": completed.returncode})
    deadline = time.monotonic() + 12
    remaining = list_codex_desktop_processes()
    while remaining and time.monotonic() < deadline:
        time.sleep(0.5)
        remaining = list_codex_desktop_processes()
    return {
        "success": not remaining,
        "target_pids": target_pids,
        "taskkill": results,
        "remaining_pids": [int(item.get("ProcessId") or 0) for item in remaining],
        "verified_at": _now_iso(),
    }
