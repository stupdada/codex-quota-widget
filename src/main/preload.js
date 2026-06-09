const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexQuota", {
  getQuota: () => ipcRenderer.invoke("quota:get"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  getAlwaysOnTop: () => ipcRenderer.invoke("window:alwaysOnTop:get"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:alwaysOnTop:set", value),
  getCompactMode: () => ipcRenderer.invoke("window:compact:get"),
  setCompactMode: (value) => ipcRenderer.invoke("window:compact:set", value),
  getCompactScale: () => ipcRenderer.invoke("window:compactScale:get"),
  setCompactScale: (value) => ipcRenderer.invoke("window:compactScale:set", value),
  openCodex: () => ipcRenderer.invoke("external:openCodex"),
  onRefresh: (callback) => {
    ipcRenderer.on("quota:refresh", callback);
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
