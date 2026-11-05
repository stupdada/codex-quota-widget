const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tokenDesktopShortcuts", {
  get: () => ipcRenderer.invoke("shortcuts:get"),
  set: (settings) => ipcRenderer.invoke("shortcuts:set", settings)
});

contextBridge.exposeInMainWorld("tokenDesktopSignalSettings", {
  get: () => ipcRenderer.invoke("signal:settings:get"),
  set: (settings) => ipcRenderer.invoke("signal:settings:set", settings),
  reset: () => ipcRenderer.invoke("signal:settings:reset")
});

contextBridge.exposeInMainWorld("tokenDashboardActivation", {
  subscribe: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = () => callback();
    ipcRenderer.on("dashboard:activated", handler);
    return () => ipcRenderer.removeListener("dashboard:activated", handler);
  }
});
