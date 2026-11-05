"""Small native Windows tray icon used by the dashboard UI process."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

import win32api
import win32con
import win32gui


class TrayIcon:
    MESSAGE = win32con.WM_USER + 20
    OPEN_ID = 1001
    EXIT_ID = 1002

    def __init__(
        self,
        icon_path: Path,
        title: str,
        *,
        on_open: Callable[[], None],
        on_exit: Callable[[], None],
    ) -> None:
        self.icon_path = icon_path
        self.title = title
        self.on_open = on_open
        self.on_exit = on_exit
        self._hwnd: int | None = None
        self._notify_id: tuple | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="token-dashboard-tray", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=3)

    def stop(self) -> None:
        hwnd = self._hwnd
        if hwnd:
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)

    def _run(self) -> None:
        class_name = f"CodexTokenDashboardTray-{id(self)}"
        message_map = {
            self.MESSAGE: self._on_tray,
            win32con.WM_DESTROY: self._on_destroy,
        }
        wc = win32gui.WNDCLASS()
        wc.hInstance = win32api.GetModuleHandle(None)
        wc.lpszClassName = class_name
        wc.lpfnWndProc = message_map
        class_atom = win32gui.RegisterClass(wc)
        hwnd = win32gui.CreateWindow(
            class_atom,
            f"{self.title} Tray",
            0,
            0,
            0,
            win32con.CW_USEDEFAULT,
            win32con.CW_USEDEFAULT,
            0,
            0,
            wc.hInstance,
            None,
        )
        self._hwnd = hwnd
        try:
            if self.icon_path.exists():
                icon = win32gui.LoadImage(
                    0,
                    str(self.icon_path),
                    win32con.IMAGE_ICON,
                    0,
                    0,
                    win32con.LR_LOADFROMFILE | win32con.LR_DEFAULTSIZE,
                )
            else:
                icon = win32gui.LoadIcon(0, win32con.IDI_APPLICATION)
            self._notify_id = (
                hwnd,
                0,
                win32gui.NIF_ICON | win32gui.NIF_MESSAGE | win32gui.NIF_TIP,
                self.MESSAGE,
                icon,
                self.title,
            )
            win32gui.Shell_NotifyIcon(win32gui.NIM_ADD, self._notify_id)
            self._ready.set()
            win32gui.PumpMessages()
        finally:
            if self._notify_id is not None:
                try:
                    win32gui.Shell_NotifyIcon(win32gui.NIM_DELETE, self._notify_id)
                except win32gui.error:
                    pass
            self._hwnd = None
            self._ready.set()

    def _on_tray(self, hwnd: int, _msg: int, _wparam: int, lparam: int) -> int:
        if lparam == win32con.WM_LBUTTONDBLCLK:
            self.on_open()
            return 0
        if lparam not in (win32con.WM_RBUTTONUP, win32con.WM_CONTEXTMENU):
            return 0
        menu = win32gui.CreatePopupMenu()
        try:
            win32gui.AppendMenu(menu, win32con.MF_STRING, self.OPEN_ID, "打开")
            win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
            win32gui.AppendMenu(menu, win32con.MF_STRING, self.EXIT_ID, "退出")
            position = win32gui.GetCursorPos()
            win32gui.SetForegroundWindow(hwnd)
            command = win32gui.TrackPopupMenu(
                menu,
                win32con.TPM_LEFTALIGN | win32con.TPM_RETURNCMD | win32con.TPM_NONOTIFY,
                position[0],
                position[1],
                0,
                hwnd,
                None,
            )
            if command == self.OPEN_ID:
                self.on_open()
            elif command == self.EXIT_ID:
                self.on_exit()
        finally:
            win32gui.DestroyMenu(menu)
        return 0

    @staticmethod
    def _on_destroy(_hwnd: int, _msg: int, _wparam: int, _lparam: int) -> int:
        win32gui.PostQuitMessage(0)
        return 0
