const state = {
  dashboard: null,
  compactDisplayMode: "hud",
  compactExpanded: false,
  compactScale: 0.46,
  compactTheme: "glass",
  signalSettings: { warningBreathMs: 4000, criticalBlinkMs: 3000 },
  resizing: null,
  moving: null,
  resizeFrame: null,
  moveFrame: null,
  hoverProbeTimer: null,
  hoverProbeInFlight: false
};

const COMPACT_HOVER_PROBE_MS = 80;
const COMPACT_SCALE_LIMITS = { min: 0.46, max: 1.25 };
const COMPACT_DEFAULT_SCALE = 0.46;
const COMPACT_DEFAULT_SCALE_SNAP_DISTANCE = 0.035;
const COMPACT_THEME_STORAGE_KEY = "codexQuotaCompactTheme";
const COMPACT_THEMES = new Set(["glass", "island"]);
const COMPACT_DISPLAY_MODES = new Set(["hud", "topStrip"]);

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required DOM element: #${id}`);
  return element;
}

const els = {
  body: document.body,
  compactHud: requiredElement("compactHud"),
  compactControls: requiredElement("compactControls"),
  compactWeeklyFill: requiredElement("compactWeeklyFill"),
  compactShortFill: requiredElement("compactShortFill"),
  compactWeeklyIdeal: requiredElement("compactWeeklyIdeal"),
  compactShortIdeal: requiredElement("compactShortIdeal"),
  compactWeeklyIdealText: requiredElement("compactWeeklyIdealText"),
  compactShortIdealText: requiredElement("compactShortIdealText"),
  compactWeeklyText: requiredElement("compactWeeklyText"),
  compactShortText: requiredElement("compactShortText"),
  compactWeeklyDelta: requiredElement("compactWeeklyDelta"),
  compactShortDelta: requiredElement("compactShortDelta"),
  compactThemeBtn: requiredElement("compactThemeBtn"),
  compactDashboardBtn: requiredElement("compactDashboardBtn"),
  compactCloseBtn: requiredElement("compactCloseBtn"),
  compactResizeHandle: requiredElement("compactResizeHandle"),
  compactQuotaStatus: requiredElement("compactQuotaStatus"),
  compactStatusKicker: requiredElement("compactStatusKicker"),
  compactStatusValue: requiredElement("compactStatusValue"),
  compactQuotaSignal: requiredElement("compactQuotaSignal"),
  compactResetInfo: requiredElement("compactResetInfo"),
  compactShortResetText: requiredElement("compactShortResetText"),
  compactWeeklyResetText: requiredElement("compactWeeklyResetText"),
  compactUsageLabel: requiredElement("compactUsageLabel"),
  compactUsageValue: requiredElement("compactUsageValue"),
  compactStripUsage: requiredElement("compactStripUsage")
};

function setText(element, value) {
  element.textContent = value;
}

function setAttr(element, name, value) {
  element.setAttribute(name, value);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercentValue(value) {
  const number = finiteNumberOrNull(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function percentText(value) {
  const number = finiteNumberOrNull(value);
  return number === null ? "--" : `${Math.round(number)}%`;
}

function signedDeltaText(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return "--";
  const rounded = Math.round(number);
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function compactDeltaClass(value) {
  const number = finiteNumberOrNull(value);
  if (number === null || Math.round(number) === 0) return "compact-delta neutral";
  return `compact-delta ${number > 0 ? "positive" : "negative"}`;
}

function markerPosition(value) {
  return `clamp(2px, ${value}%, calc(100% - 2px))`;
}

function setCompactTrack(fillElement, idealElement, idealTextElement, actualValue, idealValue) {
  const actual = clampPercentValue(actualValue);
  const ideal = clampPercentValue(idealValue);
  fillElement.style.width = actual === null ? "0%" : `${actual}%`;
  fillElement.hidden = actual === null;
  idealElement.hidden = ideal === null;
  idealTextElement.hidden = ideal === null;
  if (ideal === null) {
    idealElement.style.left = "0%";
    idealTextElement.style.left = "0%";
    setText(idealTextElement, "--");
    setAttr(idealTextElement, "title", "理想剩余不可用");
    return;
  }
  idealElement.style.left = markerPosition(ideal);
  idealTextElement.style.left = `clamp(20px, ${ideal}%, calc(100% - 20px))`;
  setText(idealTextElement, percentText(ideal));
  setAttr(idealTextElement, "title", `线性理想剩余 ${percentText(ideal)}`);
}

function renderCompactMetric(elements, cycle) {
  setCompactTrack(elements.fill, elements.ideal, elements.idealText, cycle?.remainingPercent, cycle?.idealRemainingPercent);
  setText(elements.percentText, percentText(cycle?.remainingPercent));
  setText(elements.deltaText, signedDeltaText(cycle?.delta));
  elements.deltaText.className = compactDeltaClass(cycle?.delta);
}

function formatReset(cycle) {
  if (!cycle?.resetAt) return "--";
  const date = new Date(cycle.resetAt);
  if (!Number.isFinite(date.getTime())) return "--";
  const pad2 = (value) => String(value).padStart(2, "0");
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function statusWords(status) {
  const labels = {
    healthy: ["额度", "正常"],
    abundant: ["余量", "充足"],
    behind: ["低于", "理想"],
    low: ["额度", "偏低"],
    critical: ["接近", "耗尽"],
    stale: ["数据", "已过期"],
    unavailable: ["服务", "不可用"]
  };
  return labels[status] || labels.unavailable;
}

function renderDashboardState(snapshot) {
  state.dashboard = snapshot;
  const widget = snapshot?.widget || null;
  const cycles = widget?.cycles || {};
  renderCompactMetric(
    {
      fill: els.compactWeeklyFill,
      ideal: els.compactWeeklyIdeal,
      idealText: els.compactWeeklyIdealText,
      percentText: els.compactWeeklyText,
      deltaText: els.compactWeeklyDelta
    },
    cycles.sevenDay
  );
  renderCompactMetric(
    {
      fill: els.compactShortFill,
      ideal: els.compactShortIdeal,
      idealText: els.compactShortIdealText,
      percentText: els.compactShortText,
      deltaText: els.compactShortDelta
    },
    cycles.fiveHour
  );
  setText(els.compactWeeklyResetText, formatReset(cycles.sevenDay));
  setText(els.compactShortResetText, formatReset(cycles.fiveHour));

  const usage = widget?.usage || { label: "5h", displayValue: "--" };
  const unavailable = widget?.connectionStatus === "unavailable";
  const usageValue = unavailable && usage.displayValue !== "--" ? `${usage.displayValue} · 已过期` : usage.displayValue;
  setText(els.compactUsageLabel, usage.label || "用量");
  setText(els.compactUsageValue, usageValue || "--");
  setText(els.compactStripUsage, `${usage.label || ""} 用量 ${usageValue || "--"}`.trim());
  const usageTitle = `${usage.detailLabel || usage.label || "用量"}：${usageValue || "--"}`;
  setAttr(els.compactUsageValue, "title", usageTitle);
  setAttr(els.compactStripUsage, "title", usageTitle);

  const signal = widget?.quotaSignal || {
    status: snapshot?.refreshing ? "unavailable" : "unavailable",
    severity: "muted",
    label: snapshot?.refreshing ? "正在连接" : "额度不可用",
    detail: snapshot?.error?.message || "Token 仪表盘服务未提供额度数据"
  };
  const [kicker, value] = statusWords(signal.status);
  setText(els.compactStatusKicker, snapshot?.refreshing && !cycles.fiveHour && !cycles.sevenDay ? "正在" : kicker);
  setText(els.compactStatusValue, snapshot?.refreshing && !cycles.fiveHour && !cycles.sevenDay ? "连接" : value);
  els.compactQuotaStatus.className = `compact-advice ${signal.severity || "muted"} quota-${signal.status || "unavailable"}`;
  const detail = [signal.detail, snapshot?.error?.message].filter(Boolean).join("；");
  setAttr(els.compactQuotaStatus, "title", detail);
  els.compactQuotaSignal.className = `compact-quota-signal quota-${signal.status || "unavailable"}`;
  setAttr(els.compactQuotaSignal, "title", signal.label || "额度不可用");
  setAttr(els.compactQuotaSignal, "aria-label", signal.label || "额度不可用");
  els.body.dataset.state = signal.status || "unavailable";
}

function renderSignalSettings(settings) {
  const warningBreathMs = clampSignalMs(settings?.warningBreathMs, 4000);
  const criticalBlinkMs = clampSignalMs(settings?.criticalBlinkMs, 3000);
  state.signalSettings = { warningBreathMs, criticalBlinkMs };
  document.documentElement.style.setProperty("--signal-warning-cycle", `${warningBreathMs}ms`);
  document.documentElement.style.setProperty("--signal-critical-cycle", `${criticalBlinkMs}ms`);
}

function clampSignalMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(20000, Math.max(1000, Math.round(number)));
}

function normalizeCompactDisplayMode(value) {
  return COMPACT_DISPLAY_MODES.has(value) ? value : "hud";
}

function isTopStripMode() {
  return state.compactDisplayMode === "topStrip";
}

function renderCompactDisplayMode(value) {
  state.compactDisplayMode = normalizeCompactDisplayMode(value);
  els.body.dataset.compactDisplay = state.compactDisplayMode;
  renderCompactExpanded(false);
  if (!isTopStripMode()) setCompactMousePassthrough(false);
  else updateCompactMousePassthrough();
}

function clampCompactScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(COMPACT_SCALE_LIMITS.max, Math.max(COMPACT_SCALE_LIMITS.min, scale));
}

function snapCompactScale(value) {
  const scale = clampCompactScale(value);
  return Math.abs(scale - COMPACT_DEFAULT_SCALE) <= COMPACT_DEFAULT_SCALE_SNAP_DISTANCE ? COMPACT_DEFAULT_SCALE : scale;
}

function compensatedFontSize(scale, { min, base, max }) {
  const safeScale = clampCompactScale(scale);
  const visualSize = Math.min(max, Math.max(min, base * Math.sqrt(safeScale / COMPACT_DEFAULT_SCALE)));
  return visualSize / safeScale;
}

function renderCompactScale(value) {
  state.compactScale = clampCompactScale(value);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--compact-scale", String(state.compactScale));
  rootStyle.setProperty("--compact-ideal-font-size", `${compensatedFontSize(state.compactScale, { min: 8.5, base: 8.5, max: 11.5 })}px`);
  rootStyle.setProperty("--compact-advice-font-size", `${compensatedFontSize(state.compactScale, { min: 10, base: 10.5, max: 13 })}px`);
  rootStyle.setProperty("--compact-detail-font-size", `${compensatedFontSize(state.compactScale, { min: 10, base: 10.5, max: 13 })}px`);
  rootStyle.setProperty("--compact-detail-label-font-size", `${compensatedFontSize(state.compactScale, { min: 10.5, base: 11, max: 13.5 })}px`);
  rootStyle.setProperty("--compact-detail-line-height", `${compensatedFontSize(state.compactScale, { min: 12, base: 12.5, max: 16 })}px`);
}

function normalizeCompactTheme(value) {
  return COMPACT_THEMES.has(value) ? value : "glass";
}

function renderCompactTheme(value, options = {}) {
  const theme = normalizeCompactTheme(value);
  state.compactTheme = theme;
  els.body.dataset.compactTheme = theme;
  setText(els.compactThemeBtn, theme === "glass" ? "岛" : "玻");
  if (options.persist !== false) window.localStorage.setItem(COMPACT_THEME_STORAGE_KEY, theme);
}

function toggleCompactTheme() {
  renderCompactTheme(state.compactTheme === "glass" ? "island" : "glass");
}

function reportInteractionError(error) {
  console.error("Codex quota LED interaction failed:", error);
}

function setCompactMousePassthrough(enabled) {
  window.codexQuota.setCompactMousePassthrough(Boolean(enabled)).catch(reportInteractionError);
}

function updateCompactMousePassthrough() {
  setCompactMousePassthrough(isTopStripMode() && !state.moving && !state.resizing && !state.compactExpanded);
}

function startCompactResize(event) {
  if (isTopStripMode()) return;
  event.preventDefault();
  event.stopPropagation();
  state.resizing = {
    startX: event.screenX,
    startY: event.screenY,
    startScale: state.compactScale,
    pendingScale: state.compactScale
  };
  els.body.classList.add("is-resizing");
  syncCompactHoverProbe();
  window.addEventListener("mousemove", handleCompactResize);
  window.addEventListener("mouseup", stopCompactResize, { once: true });
}

function handleCompactResize(event) {
  if (!state.resizing) return;
  event.preventDefault();
  const deltaX = event.screenX - state.resizing.startX;
  const deltaY = event.screenY - state.resizing.startY;
  const dominantDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  const nextScale = snapCompactScale(state.resizing.startScale + dominantDelta / 210);
  renderCompactScale(nextScale);
  state.resizing.pendingScale = nextScale;
  if (state.resizeFrame) return;
  state.resizeFrame = window.requestAnimationFrame(() => {
    state.resizeFrame = null;
    window.codexQuota.setCompactScale(state.resizing?.pendingScale).catch(reportInteractionError);
  });
}

function stopCompactResize() {
  if (!state.resizing) return;
  window.removeEventListener("mousemove", handleCompactResize);
  if (state.resizeFrame) window.cancelAnimationFrame(state.resizeFrame);
  state.resizeFrame = null;
  els.body.classList.remove("is-resizing");
  state.resizing = null;
  window.codexQuota.setCompactScale(state.compactScale).then(renderCompactScale).catch(reportInteractionError);
  syncCompactHoverProbe();
  updateCompactMousePassthrough();
}

function renderCompactExpanded(expanded) {
  state.compactExpanded = Boolean(expanded);
  els.body.dataset.compactExpanded = state.compactExpanded ? "true" : "false";
  syncCompactHoverProbe();
}

function setCompactExpanded(expanded) {
  const nextExpanded = Boolean(expanded);
  if (state.compactExpanded === nextExpanded) return;
  renderCompactExpanded(nextExpanded);
  if (nextExpanded) setCompactMousePassthrough(false);
  window.codexQuota.setCompactExpanded(nextExpanded).then(() => {
    if (!nextExpanded) updateCompactMousePassthrough();
  }).catch(reportInteractionError);
}

function handleCompactPointerMove(event) {
  if (state.moving || state.resizing) return;
  setCompactExpanded(isInsideCompactVisibleSurface(event));
}

function syncCompactHoverProbe() {
  if (state.hoverProbeTimer && (!state.compactExpanded || state.moving || state.resizing)) {
    window.clearInterval(state.hoverProbeTimer);
    state.hoverProbeTimer = null;
  }
  if (!state.compactExpanded || state.moving || state.resizing || state.hoverProbeTimer) return;
  state.hoverProbeTimer = window.setInterval(probeCompactHoverState, COMPACT_HOVER_PROBE_MS);
}

async function probeCompactHoverState() {
  if (!state.compactExpanded || state.moving || state.resizing || state.hoverProbeInFlight) return;
  state.hoverProbeInFlight = true;
  try {
    const cursorState = await window.codexQuota.getCursorState();
    const cursor = cursorState?.cursor;
    const bounds = cursorState?.windowBounds;
    const pointer = cursor && bounds ? { clientX: cursor.x - bounds.x, clientY: cursor.y - bounds.y } : null;
    if (!pointer || !isInsideCompactVisibleSurface(pointer)) setCompactExpanded(false);
  } catch (error) {
    reportInteractionError(error);
  } finally {
    state.hoverProbeInFlight = false;
  }
}

function isInsideElementRect(event, element) {
  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function isInsideCompactHudCapsule(event) {
  const rect = els.compactHud.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;
  const radius = rect.height / 2;
  if (x < radius) return Math.hypot(x - radius, y - radius) <= radius;
  if (x > rect.width - radius) return Math.hypot(x - (rect.width - radius), y - radius) <= radius;
  return true;
}

function isInsideCompactVisibleSurface(event) {
  if (isTopStripMode()) return isInsideElementRect(event, els.compactHud);
  if (isInsideCompactHudCapsule(event)) return true;
  if (!state.compactExpanded) return false;
  return [els.compactControls, els.compactQuotaStatus, els.compactResetInfo, els.compactResizeHandle].some((element) =>
    isInsideElementRect(event, element)
  );
}

function startCompactMove(event) {
  if (event.button !== 0 || !isInsideCompactVisibleSurface(event)) return;
  event.preventDefault();
  event.stopPropagation();
  setCompactMousePassthrough(false);
  state.moving = {
    lastX: event.screenX,
    lastY: event.screenY,
    pendingDeltaX: 0,
    pendingDeltaY: 0,
    movePromise: Promise.resolve()
  };
  els.body.classList.add("is-moving");
  syncCompactHoverProbe();
  window.addEventListener("mousemove", handleCompactMove);
  window.addEventListener("mouseup", stopCompactMove, { once: true });
}

function handleCompactMove(event) {
  if (!state.moving) return;
  event.preventDefault();
  state.moving.pendingDeltaX += event.screenX - state.moving.lastX;
  state.moving.pendingDeltaY += event.screenY - state.moving.lastY;
  state.moving.lastX = event.screenX;
  state.moving.lastY = event.screenY;
  if (state.moveFrame) return;
  state.moveFrame = window.requestAnimationFrame(() => {
    state.moveFrame = null;
    flushCompactMove();
  });
}

function flushCompactMove() {
  if (!state.moving) return Promise.resolve();
  const moving = state.moving;
  const deltaX = moving.pendingDeltaX;
  const deltaY = moving.pendingDeltaY;
  moving.pendingDeltaX = 0;
  moving.pendingDeltaY = 0;
  if (deltaX === 0 && deltaY === 0) return moving.movePromise;
  const request = moving.movePromise.catch(() => undefined).then(() => window.codexQuota.moveCompactWindow(deltaX, deltaY));
  moving.movePromise = request.catch(reportInteractionError);
  return moving.movePromise;
}

function stopCompactMove() {
  if (!state.moving) return;
  const moving = state.moving;
  window.removeEventListener("mousemove", handleCompactMove);
  if (state.moveFrame) window.cancelAnimationFrame(state.moveFrame);
  state.moveFrame = null;
  const finishMove = flushCompactMove() || moving.movePromise;
  els.body.classList.remove("is-moving");
  state.moving = null;
  syncCompactHoverProbe();
  finishMove.then(() => window.codexQuota.snapCompactWindow()).then((result) => {
    renderCompactDisplayMode(result?.displayMode);
    updateCompactMousePassthrough();
  }).catch(reportInteractionError);
}

els.compactDashboardBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  window.codexQuota.openDashboard().catch(reportInteractionError);
});
els.compactCloseBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  window.codexQuota.minimize();
});
els.compactThemeBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleCompactTheme();
});
window.addEventListener("mousemove", handleCompactPointerMove);
window.addEventListener("mouseout", (event) => {
  if (!event.relatedTarget) setCompactExpanded(false);
});
els.compactHud.addEventListener("mousedown", startCompactMove);
els.compactResizeHandle.addEventListener("mousedown", startCompactResize);

renderCompactTheme(normalizeCompactTheme(window.localStorage.getItem(COMPACT_THEME_STORAGE_KEY)), { persist: false });
renderSignalSettings(state.signalSettings);
renderDashboardState({ status: "loading", refreshing: true, widget: null });

window.codexQuota.onDashboardChanged(renderDashboardState);
window.codexQuota.onCompactScaleChanged((value) => {
  if (!state.resizing) renderCompactScale(value);
});
window.codexQuota.onCompactDisplayModeChanged(renderCompactDisplayMode);
window.codexQuota.onSignalSettingsChanged(renderSignalSettings);

window.codexQuota.getCompactDisplayMode().then(renderCompactDisplayMode).catch(reportInteractionError);
window.codexQuota.getCompactScale().then(renderCompactScale).catch(reportInteractionError);
window.codexQuota.getSignalSettings().then(renderSignalSettings).catch(reportInteractionError);
window.codexQuota.getDashboardState().then(renderDashboardState).catch((error) =>
  renderDashboardState({ status: "error", error: { message: error?.message || String(error) }, widget: null })
);
