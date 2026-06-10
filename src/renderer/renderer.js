const state = {
  lang: "zh",
  quota: null,
  error: null,
  compact: false,
  compactScale: 0.65,
  resizing: null,
  moving: null,
  resizeFrame: null,
  moveFrame: null,
  loading: false
};

const COMPACT_SCALE_LIMITS = { min: 0.33, max: 1.8 };

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return element;
}

function requiredElements(selector) {
  const elements = document.querySelectorAll(selector);
  if (elements.length === 0) {
    throw new Error(`Missing required DOM elements: ${selector}`);
  }
  return elements;
}

const els = {
  body: document.body,
  trafficLight: requiredElement("trafficLight"),
  brandName: requiredElement("brandName"),
  stateText: requiredElement("stateText"),
  langBtn: requiredElement("langBtn"),
  compactBtn: requiredElement("compactBtn"),
  pinBtn: requiredElement("pinBtn"),
  refreshBtn: requiredElement("refreshBtn"),
  minimizeBtn: requiredElement("minimizeBtn"),
  closeBtn: requiredElement("closeBtn"),
  liquidMeter: requiredElement("liquidMeter"),
  liquidFill: requiredElement("liquidFill"),
  remaining: requiredElement("remaining"),
  remainingLabel: requiredElement("remainingLabel"),
  compactOrb: requiredElement("compactOrb"),
  compactWeeklyFill: requiredElement("compactWeeklyFill"),
  compactShortFill: requiredElement("compactShortFill"),
  compactWeeklyIdeal: requiredElement("compactWeeklyIdeal"),
  compactShortIdeal: requiredElement("compactShortIdeal"),
  compactWeeklyIdealSurface: requiredElement("compactWeeklyIdealSurface"),
  compactShortIdealSurface: requiredElement("compactShortIdealSurface"),
  compactWeeklySurface: requiredElement("compactWeeklySurface"),
  compactShortSurface: requiredElement("compactShortSurface"),
  compactWeeklyText: requiredElement("compactWeeklyText"),
  compactShortText: requiredElement("compactShortText"),
  compactExpandBtn: requiredElement("compactExpandBtn"),
  compactCloseBtn: requiredElement("compactCloseBtn"),
  compactResizeHandle: requiredElement("compactResizeHandle"),
  compactAdviceText: requiredElement("compactAdviceText"),
  compactResetActions: requiredElements(".compact-reset-action"),
  compactShortResetText: requiredElement("compactShortResetText"),
  compactWeeklyResetText: requiredElement("compactWeeklyResetText"),
  primaryLabel: requiredElement("primaryLabel"),
  primaryText: requiredElement("primaryText"),
  secondaryLabel: requiredElement("secondaryLabel"),
  secondaryText: requiredElement("secondaryText"),
  planLabel: requiredElement("planLabel"),
  planText: requiredElement("planText"),
  paceTitle: requiredElement("paceTitle"),
  paceBadge: requiredElement("paceBadge"),
  weeklyPaceLabel: requiredElement("weeklyPaceLabel"),
  weeklyPaceText: requiredElement("weeklyPaceText"),
  actualPaceLabel: requiredElement("actualPaceLabel"),
  actualPaceText: requiredElement("actualPaceText"),
  idealPaceLabel: requiredElement("idealPaceLabel"),
  idealPaceText: requiredElement("idealPaceText"),
  deltaPaceLabel: requiredElement("deltaPaceLabel"),
  deltaPaceText: requiredElement("deltaPaceText"),
  statusDot: requiredElement("statusDot"),
  statusText: requiredElement("statusText")
};

const copy = {
  zh: {
    brand: "Codex 额度",
    loading: "读取中",
    ready: "已更新",
    error: "读取失败",
    remaining: "剩余",
    primary: "5小时窗口",
    secondary: "7天窗口",
    plan: "计划",
    unknown: "未知",
    refresh: "刷新",
    hide: "隐藏",
    hideToTray: "隐藏到托盘",
    close: "退出",
    pin: "置顶",
    unpin: "取消置顶",
    compact: "紧凑窗口",
    expand: "展开窗口",
    resize: "缩放",
    statusLoading: "正在读取 Codex 额度...",
    statusReady: "额度已更新",
    statusError: "无法读取 Codex 额度",
    authRequired: "Codex CLI 需要登录后才能读取额度",
    paceTitle: "使用节奏建议",
    weeklyPace: "7天节奏",
    actualRemaining: "实际剩余",
    idealRemaining: "理想剩余",
    paceDelta: "偏差",
    status: {
      accelerate: "可加快使用",
      normal: "正常",
      slow: "建议减速",
      critical: "接近耗尽/暂停高消耗任务",
      unknown: "无法判断"
    },
    reasons: {
      ahead: "7天窗口剩余额度高于当前时间进度",
      onTrack: "7天窗口消耗与当前时间进度基本一致",
      behind: "7天窗口剩余额度低于当前时间进度",
      critical: "7天窗口剩余额度不高于 5%",
      insufficientData: "7天窗口缺少 reset 时间或窗口时长",
      missingLongWindow: "没有可用于主判断的 7天窗口数据"
    },
    reset: "重置",
    noReset: "未提供重置时间"
  },
  en: {
    brand: "Codex Quota",
    loading: "Loading",
    ready: "Updated",
    error: "Failed",
    remaining: "left",
    primary: "5-hour window",
    secondary: "7-day window",
    plan: "Plan",
    unknown: "Unknown",
    refresh: "Refresh",
    hide: "Hide",
    hideToTray: "Hide to tray",
    close: "Quit",
    pin: "Pin",
    unpin: "Unpin",
    compact: "Compact",
    expand: "Expand",
    resize: "Resize",
    statusLoading: "Reading Codex quota...",
    statusReady: "Quota updated",
    statusError: "Unable to read Codex quota",
    authRequired: "Codex CLI must be signed in before quota can be read",
    paceTitle: "Usage pace advice",
    weeklyPace: "7-day pace",
    actualRemaining: "Actual",
    idealRemaining: "Ideal",
    paceDelta: "Delta",
    status: {
      accelerate: "Speed up",
      normal: "Normal",
      slow: "Slow down",
      critical: "Nearly exhausted / pause heavy tasks",
      unknown: "Unknown"
    },
    reasons: {
      ahead: "The 7-day quota is above the current time progress",
      onTrack: "The 7-day usage matches the current time progress",
      behind: "The 7-day quota is below the current time progress",
      critical: "The 7-day quota is at or below 5%",
      insufficientData: "The 7-day reset time or window duration is missing",
      missingLongWindow: "No 7-day window data is available for the main decision"
    },
    reset: "resets",
    noReset: "reset time unavailable"
  }
};

function t(path) {
  return path.split(".").reduce((value, key) => value?.[key], copy[state.lang]) ?? path;
}

function setText(element, value) {
  element.textContent = value;
}

function setTextAll(elements, value) {
  elements.forEach((element) => setText(element, value));
}

function setAttr(element, name, value) {
  element.setAttribute(name, value);
}

function percentText(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : "--";
}

function signedPercentText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const rounded = Math.round(number);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function formatWindow(window) {
  if (!window) return "--";
  const resetText = window.resetsAt ? formatReset(window.resetsAt) : t("noReset");
  return `${percentText(window.remainingPercent)} · ${resetText}`;
}

function formatReset(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return t("noReset");
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${t("reset")} ${month}/${day} ${hour}:${minute}`;
}

function compactResetTime(window) {
  if (!window?.resetsAt) return "--";
  const date = new Date(window.resetsAt);
  if (!Number.isFinite(date.getTime())) return "--";
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${month}/${day} ${hour}:${minute}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function statusClassFromRemaining(remainingPercent) {
  const remaining = Number(remainingPercent);
  if (!Number.isFinite(remaining)) return "loading";
  if (remaining <= 0) return "danger";
  if (remaining < 10) return "warning";
  return "good";
}

function renderStaticCopy() {
  setText(els.brandName, t("brand"));
  setText(els.remainingLabel, t("remaining"));
  setText(els.primaryLabel, t("primary"));
  setText(els.secondaryLabel, t("secondary"));
  setText(els.planLabel, t("plan"));
  setText(els.paceTitle, t("paceTitle"));
  setText(els.weeklyPaceLabel, t("weeklyPace"));
  setText(els.actualPaceLabel, t("actualRemaining"));
  setText(els.idealPaceLabel, t("idealRemaining"));
  setText(els.deltaPaceLabel, t("paceDelta"));
  setTextAll(els.compactResetActions, t("reset"));
  setText(els.langBtn, state.lang === "zh" ? "EN" : "中");
  renderCompactButton(state.compact);
  setAttr(els.refreshBtn, "title", t("refresh"));
  setAttr(els.refreshBtn, "aria-label", t("refresh"));
  setAttr(els.minimizeBtn, "title", t("hide"));
  setAttr(els.minimizeBtn, "aria-label", t("hide"));
  setAttr(els.closeBtn, "title", t("close"));
  setAttr(els.closeBtn, "aria-label", t("close"));
  setAttr(els.compactExpandBtn, "title", t("expand"));
  setAttr(els.compactExpandBtn, "aria-label", t("expand"));
  setAttr(els.compactCloseBtn, "title", t("hideToTray"));
  setAttr(els.compactCloseBtn, "aria-label", t("hideToTray"));
  setAttr(els.compactResizeHandle, "title", t("resize"));
  setAttr(els.compactResizeHandle, "aria-label", t("resize"));
}

function renderQuota(quota) {
  state.quota = quota;
  state.error = null;
  renderStaticCopy();

  const remaining = quota?.remainingPercent;
  const quotaState = statusClassFromRemaining(remaining);
  els.body.dataset.state = quotaState;
  els.trafficLight.className = `traffic-light ${quotaState}`;
  els.statusDot.className = `status-dot ${quotaState}`;
  setText(els.stateText, t("ready"));
  setText(els.statusText, t("statusReady"));
  setText(els.remaining, percentText(remaining));
  els.liquidFill.style.height = percentText(remaining);
  renderCompactOrb(quota);
  setText(els.primaryText, formatWindow(quota?.primary));
  setText(els.secondaryText, formatWindow(quota?.secondary));
  setText(els.planText, quota?.planType || t("unknown"));

  renderPaceAdvice(quota?.paceAdvice);
}

function renderPaceAdvice(advice) {
  const weekly = advice?.longWindow;
  const overall = advice?.overall || { status: "unknown", severity: "muted", reasonCode: "missingLongWindow" };

  setText(els.weeklyPaceText, t(`status.${weekly?.status || "unknown"}`));
  setText(els.paceBadge, t(`status.${overall.status}`));
  setText(els.actualPaceText, percentText(weekly?.remainingPercent));
  setText(els.idealPaceText, percentText(weekly?.idealRemainingPercent));
  setText(els.deltaPaceText, signedPercentText(weekly?.paceDelta));
  els.paceBadge.className = `pace-badge ${overall.severity}`;
  renderCompactAdvice(advice);
}

function renderCompactAdvice(advice) {
  const overall = advice?.overall || { status: "unknown", severity: "muted" };
  setText(els.compactAdviceText, t(`status.${overall.status}`));
  els.compactAdviceText.className = `compact-advice ${overall.severity}`;
}

function setFillHeight(element, value) {
  const geometry = surfaceGeometry(value);
  element.hidden = !geometry || geometry.bottom === "0%";
  element.style.height = geometry?.bodyHeight || "0%";
}

function setIdealMarker(element, surfaceElement, value) {
  const geometry = surfaceGeometry(value);
  element.hidden = !geometry || geometry.bottom === "0%";
  element.style.height = geometry?.bodyHeight || "0%";
  element.style.removeProperty("--ideal-position");
  setSurfaceLevel(surfaceElement, value);
}

function surfaceGeometry(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const level = Math.min(100, Math.max(0, number));
  const distanceFromCenter = Math.abs(level - 50) / 50;
  const widthRatio = Math.sqrt(Math.max(0, 1 - distanceFromCenter * distanceFromCenter));
  const edgeWidthBoost = distanceFromCenter * distanceFromCenter * 18;
  const minWidthPercent = 32 + distanceFromCenter * distanceFromCenter * 10;
  const widthPercent = Math.min(100, Math.max(minWidthPercent, widthRatio * 100 + edgeWidthBoost));
  const heightPx = 8 + widthRatio * 4;
  const halfHeightPx = heightPx / 2;
  return {
    bottom: `${level}%`,
    bodyHeight: `${level}%`,
    surfaceBottom: `max(0px, calc(${level}% - ${halfHeightPx}px))`,
    width: `${widthPercent}%`,
    height: `${heightPx}px`
  };
}

function setSurfaceLevel(element, value) {
  const geometry = surfaceGeometry(value);
  element.hidden = !geometry || geometry.bottom === "0%";
  element.style.bottom = geometry?.surfaceBottom || "0%";
  element.style.setProperty("--surface-width", geometry?.width || "18%");
  element.style.setProperty("--surface-height", geometry?.height || "10px");
}

function renderCompactOrb(quota) {
  const weekly = quota?.paceAdvice?.longWindow;
  const short = quota?.paceAdvice?.shortWindow;
  const weeklyPercent = percentText(weekly?.remainingPercent);
  const shortPercent = percentText(short?.remainingPercent);

  setFillHeight(els.compactWeeklyFill, weekly?.remainingPercent);
  setFillHeight(els.compactShortFill, short?.remainingPercent);
  setIdealMarker(els.compactWeeklyIdeal, els.compactWeeklyIdealSurface, weekly?.idealRemainingPercent);
  setIdealMarker(els.compactShortIdeal, els.compactShortIdealSurface, short?.idealRemainingPercent);
  setSurfaceLevel(els.compactWeeklySurface, weekly?.remainingPercent);
  setSurfaceLevel(els.compactShortSurface, short?.remainingPercent);
  setText(els.compactWeeklyText, weeklyPercent);
  setText(els.compactShortText, shortPercent);
  setText(els.compactShortResetText, compactResetTime(quota?.primary));
  setText(els.compactWeeklyResetText, compactResetTime(quota?.secondary));
}

function renderLoading() {
  renderStaticCopy();
  els.body.dataset.state = "loading";
  els.trafficLight.className = "traffic-light loading";
  els.statusDot.className = "status-dot loading";
  setText(els.stateText, t("loading"));
  setText(els.statusText, t("statusLoading"));
  if (!state.quota) {
    renderCompactOrb(null);
    renderCompactAdvice(null);
  }
}

function renderError(error) {
  state.quota = null;
  state.error = error;
  renderStaticCopy();
  els.body.dataset.state = "danger";
  els.trafficLight.className = "traffic-light danger";
  els.statusDot.className = "status-dot danger";
  setText(els.stateText, t("error"));
  setText(els.statusText, `${t("statusError")}：${friendlyErrorMessage(error)}`);
  setText(els.remaining, "--%");
  els.liquidFill.style.height = "0%";
  renderCompactOrb(null);
  setText(els.primaryText, "--");
  setText(els.secondaryText, "--");
  setText(els.planText, "--");
  renderPaceAdvice(null);
}

function renderQuotaState(snapshot) {
  const quota = snapshot?.quota || null;
  const error = snapshot?.error || null;
  const isRefreshing = Boolean(snapshot?.refreshing || snapshot?.status === "loading");
  state.loading = isRefreshing;

  if (quota) {
    renderQuota(quota);
    if (isRefreshing) {
      setText(els.stateText, t("loading"));
      setText(els.statusText, t("statusLoading"));
    } else if (snapshot?.status === "error" && error) {
      state.error = error;
      setText(els.stateText, t("error"));
      setText(els.statusText, `${t("statusError")}: ${friendlyErrorMessage(error)}`);
    }
    return;
  }

  if (snapshot?.status === "error") {
    renderError(error);
    state.loading = false;
  } else {
    renderLoading();
  }
}

function friendlyErrorMessage(error) {
  const message = error?.message || "";
  if (message.toLowerCase().includes("authentication required")) {
    return t("authRequired");
  }
  return message || t("unknown");
}

async function refreshQuota() {
  if (state.loading) return;
  state.loading = true;
  if (state.quota) {
    renderQuotaState({ status: "loading", quota: state.quota, refreshing: true });
  } else {
    renderLoading();
  }

  try {
    const quotaState = await window.codexQuota.refreshQuota();
    renderQuotaState(quotaState);
  } catch (error) {
    renderError(error);
  } finally {
    state.loading = false;
  }
}

async function syncAlwaysOnTop() {
  const isPinned = await window.codexQuota.getAlwaysOnTop();
  renderPin(isPinned);
}

async function syncCompactMode() {
  const isCompact = await window.codexQuota.getCompactMode();
  renderCompactMode(isCompact);
}

async function syncCompactScale() {
  const compactScale = await window.codexQuota.getCompactScale();
  renderCompactScale(compactScale);
}

function renderPin(isPinned) {
  els.pinBtn.classList.toggle("active", Boolean(isPinned));
  const label = isPinned ? t("unpin") : t("pin");
  setAttr(els.pinBtn, "title", label);
  setAttr(els.pinBtn, "aria-label", label);
}

function renderCompactMode(isCompact) {
  state.compact = Boolean(isCompact);
  els.body.dataset.view = state.compact ? "compact" : "full";
  renderCompactButton(state.compact);
}

function clampCompactScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(COMPACT_SCALE_LIMITS.max, Math.max(COMPACT_SCALE_LIMITS.min, scale));
}

function renderCompactScale(value) {
  state.compactScale = clampCompactScale(value);
  document.documentElement.style.setProperty("--compact-scale", String(state.compactScale));
}

function reportInteractionError(error) {
  console.error("Codex Quota Widget interaction failed:", error);
}

function renderCompactButton(isCompact) {
  const label = isCompact ? t("expand") : t("compact");
  els.compactBtn.classList.toggle("active", Boolean(isCompact));
  setAttr(els.compactBtn, "title", label);
  setAttr(els.compactBtn, "aria-label", label);
}

function startCompactResize(event) {
  if (!state.compact) return;
  event.preventDefault();
  event.stopPropagation();
  state.resizing = {
    startX: event.screenX,
    startY: event.screenY,
    startScale: state.compactScale,
    pendingScale: state.compactScale
  };
  els.body.classList.add("is-resizing");
  window.addEventListener("mousemove", handleCompactResize);
  window.addEventListener("mouseup", stopCompactResize, { once: true });
}

function handleCompactResize(event) {
  if (!state.resizing) return;
  event.preventDefault();
  const deltaX = event.screenX - state.resizing.startX;
  const deltaY = event.screenY - state.resizing.startY;
  const dominantDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  const nextScale = clampCompactScale(state.resizing.startScale + dominantDelta / 180);
  renderCompactScale(nextScale);
  scheduleCompactScaleCommit(nextScale);
}

function scheduleCompactScaleCommit(scale) {
  if (!state.resizing) return;
  state.resizing.pendingScale = scale;
  if (state.resizeFrame) return;

  state.resizeFrame = window.requestAnimationFrame(() => {
    state.resizeFrame = null;
    const pendingScale = state.resizing?.pendingScale;
    if (!Number.isFinite(Number(pendingScale))) return;
    window.codexQuota.setCompactScale(pendingScale).catch(reportInteractionError);
  });
}

function stopCompactResize() {
  if (!state.resizing) return;
  window.removeEventListener("mousemove", handleCompactResize);
  if (state.resizeFrame) {
    window.cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = null;
  }
  els.body.classList.remove("is-resizing");
  state.resizing = null;
  window.codexQuota.setCompactScale(state.compactScale).then(renderCompactScale).catch(reportInteractionError);
}

function startCompactMove(event) {
  if (!state.compact || event.button !== 0) return;
  event.preventDefault();
  state.moving = {
    lastX: event.screenX,
    lastY: event.screenY,
    pendingDeltaX: 0,
    pendingDeltaY: 0
  };
  els.body.classList.add("is-moving");
  window.addEventListener("mousemove", handleCompactMove);
  window.addEventListener("mouseup", stopCompactMove, { once: true });
}

function handleCompactMove(event) {
  if (!state.moving) return;
  event.preventDefault();
  const deltaX = event.screenX - state.moving.lastX;
  const deltaY = event.screenY - state.moving.lastY;
  state.moving.lastX = event.screenX;
  state.moving.lastY = event.screenY;
  state.moving.pendingDeltaX += deltaX;
  state.moving.pendingDeltaY += deltaY;
  scheduleCompactMove();
}

function scheduleCompactMove() {
  if (!state.moving || state.moveFrame) return;

  state.moveFrame = window.requestAnimationFrame(() => {
    state.moveFrame = null;
    if (!state.moving) return;
    flushCompactMove();
  });
}

function flushCompactMove() {
  if (!state.moving) return;
  const deltaX = state.moving.pendingDeltaX;
  const deltaY = state.moving.pendingDeltaY;
  state.moving.pendingDeltaX = 0;
  state.moving.pendingDeltaY = 0;
  if (deltaX === 0 && deltaY === 0) return;
  window.codexQuota.moveCompactWindow(deltaX, deltaY).catch(reportInteractionError);
}

function stopCompactMove() {
  if (!state.moving) return;
  window.removeEventListener("mousemove", handleCompactMove);
  if (state.moveFrame) {
    window.cancelAnimationFrame(state.moveFrame);
    state.moveFrame = null;
  }
  flushCompactMove();
  els.body.classList.remove("is-moving");
  state.moving = null;
}

els.langBtn.addEventListener("click", () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  if (state.quota) {
    renderQuota(state.quota);
  } else if (state.error) {
    renderError(state.error);
  } else {
    renderLoading();
  }
  syncAlwaysOnTop();
});

els.compactBtn.addEventListener("click", async () => {
  const isCompact = await window.codexQuota.setCompactMode(!state.compact);
  renderCompactMode(isCompact);
});

els.compactExpandBtn.addEventListener("click", async () => {
  const isCompact = await window.codexQuota.setCompactMode(false);
  renderCompactMode(isCompact);
});

els.compactCloseBtn.addEventListener("click", () => window.codexQuota.minimize());
els.compactOrb.addEventListener("mousedown", startCompactMove);
els.compactResizeHandle.addEventListener("mousedown", startCompactResize);

els.refreshBtn.addEventListener("click", refreshQuota);
els.minimizeBtn.addEventListener("click", () => window.codexQuota.minimize());
els.closeBtn.addEventListener("click", () => window.codexQuota.close());
els.pinBtn.addEventListener("click", async () => {
  const next = !els.pinBtn.classList.contains("active");
  const isPinned = await window.codexQuota.setAlwaysOnTop(next);
  renderPin(isPinned);
});

window.codexQuota.onQuotaChanged(renderQuotaState);
window.codexQuota.onAlwaysOnTopChanged(renderPin);
window.codexQuota.onCompactChanged(renderCompactMode);
window.codexQuota.onCompactScaleChanged((value) => {
  if (state.resizing) return;
  renderCompactScale(value);
});

renderLoading();
syncAlwaysOnTop();
syncCompactMode();
syncCompactScale();
window.codexQuota.getQuotaState().then(renderQuotaState).catch(renderError);
