const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mainPath = path.join(__dirname, "..", "src", "main", "main.js");
const preloadPath = path.join(__dirname, "..", "src", "main", "dashboard-preload.js");
const source = fs.readFileSync(mainPath, "utf8");
const preloadSource = fs.readFileSync(preloadPath, "utf8");

assert.equal(
  source.includes("app.disableHardwareAcceleration()"),
  false,
  "Windows dashboard must keep Electron hardware compositing enabled"
);
assert.ok(source.includes("async function createDashboardWindow()"));
assert.ok(source.includes("if (window.isMinimized()) window.restore()"));
assert.ok(source.includes('window.webContents.send("dashboard:activated")'));
assert.ok(source.includes('window.on("restore", notifyDashboardActivated)'));
assert.ok(source.includes('window.on("focus", notifyDashboardActivated)'));
assert.ok(preloadSource.includes('contextBridge.exposeInMainWorld("tokenDashboardActivation"'));

console.log("Verified dashboard hardware acceleration and native activation-refresh shell contract.");
