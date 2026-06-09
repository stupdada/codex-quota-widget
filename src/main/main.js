const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
const path = require("node:path");
const { getQuota } = require("./quota-service");

const APP_ICON_PATH = path.join(__dirname, "../../assets/app-icon.png");
const TRAY_ICON_PATH = path.join(__dirname, "../../assets/app-icon-tray-16.png");

let mainWindow;
let tray;
let isAlwaysOnTop = true;
let isCompactMode = true;
let compactScale = 0.65;

const WINDOW_SIZES = {
  full: { width: 390, height: 336 }
};

const COMPACT_BASE_SIZE = { width: 210, height: 264 };
const COMPACT_SCALE_LIMITS = { min: 0.33, max: 1.8 };

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

function createWindow() {
  const initialSize = isCompactMode ? scaledCompactSize() : WINDOW_SIZES.full;
  const minCompactSize = compactMinimumSize();
  mainWindow = new BrowserWindow({
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
      nodeIntegration: false
    }
  });

  mainWindow.setHasShadow(!isCompactMode);

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    placeWindowTopRight();
  });
}

function placeWindowTopRight() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = mainWindow.getBounds();
  const { workArea } = display;
  mainWindow.setBounds({
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
      { label: "刷新额度", click: () => mainWindow.webContents.send("quota:refresh") },
      {
        label: isCompactMode ? "展开窗口" : "紧凑窗口",
        click: () => setCompactMode(!isCompactMode)
      },
      {
        label: isAlwaysOnTop ? "取消置顶" : "置顶",
        click: () => setAlwaysOnTop(!isAlwaysOnTop)
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ])
  );
}

function setAlwaysOnTop(value) {
  isAlwaysOnTop = Boolean(value);
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  mainWindow.webContents.send("window:alwaysOnTopChanged", isAlwaysOnTop);
  rebuildTrayMenu();
  return isAlwaysOnTop;
}

function setCompactMode(value) {
  isCompactMode = Boolean(value);
  const size = isCompactMode ? scaledCompactSize() : WINDOW_SIZES.full;
  const minSize = isCompactMode ? compactMinimumSize() : WINDOW_SIZES.full;
  mainWindow.setHasShadow(!isCompactMode);
  mainWindow.setSkipTaskbar(isCompactMode);
  mainWindow.setMinimumSize(minSize.width, minSize.height);
  mainWindow.setSize(size.width, size.height, false);
  placeWindowTopRight();
  mainWindow.webContents.send("window:compactChanged", isCompactMode);
  mainWindow.webContents.send("window:compactScaleChanged", compactScale);
  rebuildTrayMenu();
  return isCompactMode;
}

function setCompactScale(value) {
  compactScale = clampCompactScale(value);
  mainWindow.webContents.send("window:compactScaleChanged", compactScale);
  if (isCompactMode) {
    const size = scaledCompactSize();
    const minSize = compactMinimumSize();
    mainWindow.setMinimumSize(minSize.width, minSize.height);
    mainWindow.setSize(size.width, size.height, false);
  }
  return compactScale;
}

function moveCompactWindow(deltaX, deltaY) {
  if (!mainWindow) throw new Error("Main window has not been created.");
  if (!isCompactMode) throw new Error("Compact window movement is only available in compact mode.");
  const parsedDeltaX = Number(deltaX);
  const parsedDeltaY = Number(deltaY);
  if (!Number.isFinite(parsedDeltaX) || !Number.isFinite(parsedDeltaY)) {
    throw new Error("Compact window movement requires finite numeric deltas.");
  }
  const bounds = mainWindow.getBounds();
  const x = Math.round(bounds.x + parsedDeltaX);
  const y = Math.round(bounds.y + parsedDeltaY);
  mainWindow.setPosition(x, y, false);
  return { x, y };
}

function toggleWindow() {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("cn.codex.quota.widget");
  }

  createWindow();
  createTray();

  ipcMain.handle("quota:get", async () => getQuota());
  ipcMain.handle("window:minimize", () => mainWindow.hide());
  ipcMain.handle("window:close", () => app.quit());
  ipcMain.handle("window:alwaysOnTop:get", () => isAlwaysOnTop);
  ipcMain.handle("window:alwaysOnTop:set", (_event, value) => setAlwaysOnTop(value));
  ipcMain.handle("window:compact:get", () => isCompactMode);
  ipcMain.handle("window:compact:set", (_event, value) => setCompactMode(value));
  ipcMain.handle("window:compactScale:get", () => compactScale);
  ipcMain.handle("window:compactScale:set", (_event, value) => setCompactScale(value));
  ipcMain.handle("window:compactMove", (_event, deltaX, deltaY) => moveCompactWindow(deltaX, deltaY));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
