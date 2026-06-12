const DEFAULTS = {
  recentFastBreathMs: 4000,
  criticalBlinkMs: 3000,
  quotaRefreshMs: 3 * 60 * 1000
};

const els = {
  statusText: document.getElementById("statusText"),
  recentFastRange: document.getElementById("recentFastRange"),
  recentFastInput: document.getElementById("recentFastInput"),
  criticalRange: document.getElementById("criticalRange"),
  criticalInput: document.getElementById("criticalInput"),
  quotaRefreshRange: document.getElementById("quotaRefreshRange"),
  quotaRefreshInput: document.getElementById("quotaRefreshInput"),
  resetBtn: document.getElementById("resetBtn"),
  saveBtn: document.getElementById("saveBtn")
};

function secondsFromMs(value, fallbackMs) {
  const number = Number(value);
  const safeMs = Number.isFinite(number) ? number : fallbackMs;
  return trimSeconds(Math.min(20, Math.max(1, safeMs / 1000)));
}

function msFromSeconds(value, fallbackMs) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallbackMs;
  return Math.round(Math.min(20, Math.max(1, number)) * 1000);
}

function minutesFromMs(value, fallbackMs) {
  const number = Number(value);
  const safeMs = Number.isFinite(number) ? number : fallbackMs;
  return Math.round(Math.min(30, Math.max(1, safeMs / (60 * 1000)))).toString();
}

function msFromMinutes(value, fallbackMs) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallbackMs;
  return Math.round(Math.min(30, Math.max(1, number)) * 60 * 1000);
}

function trimSeconds(value) {
  return Number(value.toFixed(1)).toString();
}

function setPair(range, input, seconds) {
  range.value = seconds;
  input.value = seconds;
}

function renderSettings(settings = DEFAULTS) {
  setPair(els.recentFastRange, els.recentFastInput, secondsFromMs(settings.recentFastBreathMs, DEFAULTS.recentFastBreathMs));
  setPair(els.criticalRange, els.criticalInput, secondsFromMs(settings.criticalBlinkMs, DEFAULTS.criticalBlinkMs));
  setPair(els.quotaRefreshRange, els.quotaRefreshInput, minutesFromMs(settings.quotaRefreshMs, DEFAULTS.quotaRefreshMs));
}

function readSettings() {
  return {
    recentFastBreathMs: msFromSeconds(els.recentFastInput.value, DEFAULTS.recentFastBreathMs),
    criticalBlinkMs: msFromSeconds(els.criticalInput.value, DEFAULTS.criticalBlinkMs),
    quotaRefreshMs: msFromMinutes(els.quotaRefreshInput.value, DEFAULTS.quotaRefreshMs)
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
  els.statusText.textContent = "已保存";
}

async function resetSettings() {
  const settings = await window.codexQuota.resetSignalSettings();
  renderSettings(settings);
  els.statusText.textContent = "已恢复默认";
}

bindPair(els.recentFastRange, els.recentFastInput);
bindPair(els.criticalRange, els.criticalInput);
bindPair(els.quotaRefreshRange, els.quotaRefreshInput);
els.saveBtn.addEventListener("click", () => saveSettings().catch(showError));
els.resetBtn.addEventListener("click", () => resetSettings().catch(showError));
window.codexQuota.onSignalSettingsChanged(renderSettings);
window.codexQuota.getSignalSettings().then(renderSettings).catch(showError);

function showError(error) {
  els.statusText.textContent = error?.message || String(error);
}
