const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexQuota", {
  getQuotaState: () => ipcRenderer.invoke("quota:state"),
  refreshQuota: () => ipcRenderer.invoke("quota:refresh"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  getAlwaysOnTop: () => ipcRenderer.invoke("window:alwaysOnTop:get"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:alwaysOnTop:set", value),
  getCompactMode: () => ipcRenderer.invoke("window:compact:get"),
  setCompactMode: (value) => ipcRenderer.invoke("window:compact:set", value),
  getCompactScale: () => ipcRenderer.invoke("window:compactScale:get"),
  setCompactScale: (value) => ipcRenderer.invoke("window:compactScale:set", value),
  moveCompactWindow: (deltaX, deltaY) => ipcRenderer.invoke("window:compactMove", deltaX, deltaY),
  onQuotaChanged: (callback) => {
    ipcRenderer.on("quota:changed", (_event, value) => callback(value));
  },
  onAlwaysOnTopChanged: (callback) => {
    ipcRenderer.on("window:alwaysOnTopChanged", (_event, value) => callback(value));
  },
  onCompactChanged: (callback) => {
    ipcRenderer.on("window:compactChanged", (_event, value) => callback(value));
  },
  onCompactScaleChanged: (callback) => {
    ipcRenderer.on("window:compactScaleChanged", (_event, value) => callback(value));
  }
});
