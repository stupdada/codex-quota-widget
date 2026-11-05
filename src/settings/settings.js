const DEFAULTS = {
  warningBreathMs: 4000,
  criticalBlinkMs: 3000,
  quotaRefreshMs: 3 * 60 * 1000,
  usageRange: "cycle_5h"
};

const USAGE_RANGES = new Set(["cycle_5h", "cycle_7d", "last_3h", "today", "week"]);
const els = {
  statusText: document.getElementById("statusText"),
  warningBreathRange: document.getElementById("warningBreathRange"),
  warningBreathInput: document.getElementById("warningBreathInput"),
  criticalRange: document.getElementById("criticalRange"),
  criticalInput: document.getElementById("criticalInput"),
  quotaRefreshRange: document.getElementById("quotaRefreshRange"),
  quotaRefreshInput: document.getElementById("quotaRefreshInput"),
  usageRangeSelect: document.getElementById("usageRangeSelect"),
  resetBtn: document.getElementById("resetBtn"),
  saveBtn: document.getElementById("saveBtn")
};

function trimSeconds(value) {
  return Number(value.toFixed(1)).toString();
}

function secondsFromMs(value, fallbackMs) {
  const number = Number(value);
  const safeMs = Number.isFinite(number) ? number : fallbackMs;
  return trimSeconds(Math.min(20, Math.max(1, safeMs / 1000)));
}

function msFromSeconds(value, fallbackMs) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(20, Math.max(1, number)) * 1000) : fallbackMs;
}

function minutesFromMs(value, fallbackMs) {
  const number = Number(value);
  const safeMs = Number.isFinite(number) ? number : fallbackMs;
  return Math.round(Math.min(30, Math.max(1, safeMs / (60 * 1000)))).toString();
}

function msFromMinutes(value, fallbackMs) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.min(30, Math.max(1, number)) * 60 * 1000) : fallbackMs;
}

function setPair(range, input, value) {
  range.value = value;
  input.value = value;
}

function renderSettings(settings = DEFAULTS) {
  setPair(els.warningBreathRange, els.warningBreathInput, secondsFromMs(settings.warningBreathMs, DEFAULTS.warningBreathMs));
  setPair(els.criticalRange, els.criticalInput, secondsFromMs(settings.criticalBlinkMs, DEFAULTS.criticalBlinkMs));
  setPair(els.quotaRefreshRange, els.quotaRefreshInput, minutesFromMs(settings.quotaRefreshMs, DEFAULTS.quotaRefreshMs));
  els.usageRangeSelect.value = USAGE_RANGES.has(settings.usageRange) ? settings.usageRange : DEFAULTS.usageRange;
}

function readSettings() {
  return {
    warningBreathMs: msFromSeconds(els.warningBreathInput.value, DEFAULTS.warningBreathMs),
    criticalBlinkMs: msFromSeconds(els.criticalInput.value, DEFAULTS.criticalBlinkMs),
    quotaRefreshMs: msFromMinutes(els.quotaRefreshInput.value, DEFAULTS.quotaRefreshMs),
    usageRange: USAGE_RANGES.has(els.usageRangeSelect.value) ? els.usageRangeSelect.value : DEFAULTS.usageRange
  };
}

function bindPair(range, input) {
  range.addEventListener("input", () => {
    input.value = range.value;
  });
  input.addEventListener("input", () => {
    range.value = input.value;
  });
}

async function saveSettings() {
  const settings = await window.codexQuota.setSignalSettings(readSettings());
  renderSettings(settings);
  els.statusText.textContent = "已保存；美元用量不会改变灯色";
}

async function resetSettings() {
  const settings = await window.codexQuota.resetSignalSettings();
  renderSettings(settings);
  els.statusText.textContent = "已恢复默认";
}

function showError(error) {
  els.statusText.textContent = error?.message || String(error);
}

bindPair(els.warningBreathRange, els.warningBreathInput);
bindPair(els.criticalRange, els.criticalInput);
bindPair(els.quotaRefreshRange, els.quotaRefreshInput);
els.saveBtn.addEventListener("click", () => saveSettings().catch(showError));
els.resetBtn.addEventListener("click", () => resetSettings().catch(showError));
window.codexQuota.onSignalSettingsChanged(renderSettings);
window.codexQuota.getSignalSettings().then(renderSettings).catch(showError);
