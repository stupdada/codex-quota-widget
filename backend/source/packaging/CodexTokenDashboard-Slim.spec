# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path


project_root = Path(SPECPATH).resolve().parent

a = Analysis(
    [str(project_root / 'launch_token_speed_dashboard.py')],
    pathex=[str(project_root)],
    binaries=[],
    datas=[
        (str(project_root / 'web'), 'web'),
        (str(project_root / 'packaging' / 'codex-token-dashboard.ico'), 'packaging'),
    ],
    hiddenimports=[
        'codex_token_speed_dashboard',
        'webview',
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'win32api',
        'win32con',
        'win32gui',
        'windows_tray',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'numpy',
        'PIL',
        'matplotlib',
        'pandas',
        'scipy',
        'tkinter',
        'webview.platforms.cef',
        'webview.platforms.gtk',
        'webview.platforms.qt',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='CodexTokenDashboard-Slim',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(project_root / 'packaging' / 'codex-token-dashboard.ico'),
)
