const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
const path = require("node:path");
const { QuotaStore } = require("./quota-store");

const APP_ICON_PATH = path.join(__dirname, "../../assets/app-icon.png");
const TRAY_ICON_PATH = path.join(__dirname, "../../assets/app-icon-tray-16.png");
const HIDDEN_WINDOW_RELEASE_MS = 60 * 1000;

let mainWindow;
let tray;
let quotaStore;
let releaseWindowTimer;
let ipcHandlersRegistered = false;
let isQuitting = false;
let isAlwaysOnTop = true;
let isCompactMode = true;
let compactScale = 0.65;

const WINDOW_SIZES = {
  full: { width: 390, height: 336 }
};

const COMPACT_BASE_SIZE = { width: 210, height: 264 };
const COMPACT_SCALE_LIMITS = { min: 0.33, max: 1.8 };

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(startApp);
}

function clampCompactScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(COMPACT_SCALE_LIMITS.max, Math.max(COMPACT_SCALE_LIMITS.min, scale));
}

function scaledCompactSize(scale = compactScale) {
  const safeScale = clampCompactScale(scale);
  return {
    width: Math.round(COMPACT_BASE_SIZE.width * safeScale),
    height: Math.round(COMPACT_BASE_SIZE.height * safeScale)
  };
}

function compactMinimumSize() {
  return scaledCompactSize(COMPACT_SCALE_LIMITS.min);
}

async function startApp() {
  if (process.platform === "win32") {
    app.setAppUserModelId("cn.codex.quota.widget");
  }

  quotaStore = new QuotaStore({ userDataPath: app.getPath("userData") });
  await quotaStore.loadCache();
  quotaStore.on("state", (state) => sendToWindow("quota:changed", state));

  registerIpcHandlers();
  createWindow();
  createTray();
  quotaStore.refreshNow("startup").catch(() => {});

  app.on("activate", showWindow);
}

function createWindow() {
  const existingWindow = getLiveWindow();
  if (existingWindow) return existingWindow;

  const initialSize = isCompactMode ? scaledCompactSize() : WINDOW_SIZES.full;
  const minCompactSize = compactMinimumSize();
  const window = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: minCompactSize.width,
    minHeight: minCompactSize.height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: isCompactMode,
    show: false,
    backgroundColor: "#00000000",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  mainWindow = window;
  window.setHasShadow(!isCompactMode);

  window.webContents.on("did-finish-load", () => {
    window.webContents.send("quota:changed", quotaStore.getState());
    window.webContents.send("window:alwaysOnTopChanged", isAlwaysOnTop);
    window.webContents.send("window:compactChanged", isCompactMode);
    window.webContents.send("window:compactScaleChanged", compactScale);
  });

  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.show();
    placeWindowTopRight(window);
  });

  window.on("show", () => {
    cancelWindowRelease();
    quotaStore.setWindowVisible(true);
    quotaStore.refreshNow("window-show").catch(() => {});
  });

  window.on("hide", () => {
    quotaStore.setWindowVisible(false);
    scheduleWindowRelease();
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  return window;
}

function placeWindowTopRight(window = getLiveWindow()) {
  if (!window) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = window.getBounds();
  const { workArea } = display;
  window.setBounds({
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    width,
    height
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (icon.isEmpty()) {
    throw new Error(`Tray icon is missing or invalid: ${TRAY_ICON_PATH}`);
  }
  tray = new Tray(icon);
  tray.setToolTip("Codex Quota Widget");
  rebuildTrayMenu();
  tray.on("click", toggleWindow);
}

function rebuildTrayMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示/隐藏", click: toggleWindow },
      { label: "刷新额度", click: () => quotaStore.refreshNow("tray-manual").catch(() => {}) },
      {
        label: isCompactMode ? "展开窗口" : "紧凑窗口",
        click: () => setCompactMode(!isCompactMode)
      },
      {
        label: isAlwaysOnTop ? "取消置顶" : "置顶",
        click: () => setAlwaysOnTop(!isAlwaysOnTop)
      },
      { type: "separator" },
      { label: "退出", click: quitApp }
    ])
  );
}

function registerIpcHandlers() {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.handle("quota:state", () => quotaStore.getState());
  ipcMain.handle("quota:refresh", () => quotaStore.refreshNow("manual"));
  ipcMain.handle("window:minimize", hideWindow);
  ipcMain.handle("window:close", quitApp);
  ipcMain.handle("window:alwaysOnTop:get", () => isAlwaysOnTop);
  ipcMain.handle("window:alwaysOnTop:set", (_event, value) => setAlwaysOnTop(value));
  ipcMain.handle("window:compact:get", () => isCompactMode);
  ipcMain.handle("window:compact:set", (_event, value) => setCompactMode(value));
  ipcMain.handle("window:compactScale:get", () => compactScale);
  ipcMain.handle("window:compactScale:set", (_event, value) => setCompactScale(value));
  ipcMain.handle("window:compactMove", (_event, deltaX, deltaY) => moveCompactWindow(deltaX, deltaY));
}

function setAlwaysOnTop(value) {
  isAlwaysOnTop = Boolean(value);
  const window = getLiveWindow();
  if (window) window.setAlwaysOnTop(isAlwaysOnTop);
  sendToWindow("window:alwaysOnTopChanged", isAlwaysOnTop);
  rebuildTrayMenu();
  return isAlwaysOnTop;
}

function setCompactMode(value) {
  isCompactMode = Boolean(value);
  const window = getLiveWindow();
  if (window) {
    const size = isCompactMode ? scaledCompactSize() : WINDOW_SIZES.full;
    const minSize = isCompactMode ? compactMinimumSize() : WINDOW_SIZES.full;
    window.setHasShadow(!isCompactMode);
    window.setSkipTaskbar(isCompactMode);
    window.setMinimumSize(minSize.width, minSize.height);
    window.setSize(size.width, size.height, false);
    placeWindowTopRight(window);
  }
  sendToWindow("window:compactChanged", isCompactMode);
  sendToWindow("window:compactScaleChanged", compactScale);
  rebuildTrayMenu();
  return isCompactMode;
}

function setCompactScale(value) {
  compactScale = clampCompactScale(value);
  const window = getLiveWindow();
  if (window && isCompactMode) {
    const size = scaledCompactSize();
    const minSize = compactMinimumSize();
    window.setMinimumSize(minSize.width, minSize.height);
    window.setSize(size.width, size.height, false);
  }
  sendToWindow("window:compactScaleChanged", compactScale);
  return compactScale;
}

function moveCompactWindow(deltaX, deltaY) {
  const window = getLiveWindow();
  if (!window) throw new Error("Main window has not been created.");
  if (!isCompactMode) throw new Error("Compact window movement is only available in compact mode.");
  const parsedDeltaX = Number(deltaX);
  const parsedDeltaY = Number(deltaY);
  if (!Number.isFinite(parsedDeltaX) || !Number.isFinite(parsedDeltaY)) {
    throw new Error("Compact window movement requires finite numeric deltas.");
  }
  const bounds = window.getBounds();
  const x = Math.round(bounds.x + parsedDeltaX);
  const y = Math.round(bounds.y + parsedDeltaY);
  window.setPosition(x, y, false);
  return { x, y };
}

function toggleWindow() {
  const window = getLiveWindow();
  if (window?.isVisible()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function showWindow() {
  const window = getLiveWindow();
  if (!window) {
    createWindow();
    return;
  }

  cancelWindowRelease();
  if (!window.isVisible()) window.show();
  window.focus();
  quotaStore?.setWindowVisible(true);
  quotaStore?.refreshNow("window-show").catch(() => {});
}

function hideWindow() {
  const window = getLiveWindow();
  if (window) window.hide();
}

function scheduleWindowRelease() {
  if (isQuitting) return;
  cancelWindowRelease();
  releaseWindowTimer = setTimeout(() => {
    const window = getLiveWindow();
    if (window && !window.isVisible()) {
      window.destroy();
    }
  }, HIDDEN_WINDOW_RELEASE_MS);
}

function cancelWindowRelease() {
  if (releaseWindowTimer) {
    clearTimeout(releaseWindowTimer);
    releaseWindowTimer = null;
  }
}

function quitApp() {
  isQuitting = true;
  cancelWindowRelease();
  quotaStore?.destroy();
  app.quit();
}

function getLiveWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}

function sendToWindow(channel, ...args) {
  const window = getLiveWindow();
  if (!window || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}

app.on("before-quit", () => {
  isQuitting = true;
  cancelWindowRelease();
  quotaStore?.destroy();
});

app.on("window-all-closed", (event) => {
  if (!isQuitting) event.preventDefault();
});
