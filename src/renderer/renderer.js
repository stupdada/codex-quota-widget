const state = {
  lang: "zh",
  quota: null,
  error: null,
  compact: false,
  loading: false
};

const els = {
  body: document.body,
  trafficLight: document.getElementById("trafficLight"),
  brandName: document.getElementById("brandName"),
  stateText: document.getElementById("stateText"),
  langBtn: document.getElementById("langBtn"),
  compactBtn: document.getElementById("compactBtn"),
  pinBtn: document.getElementById("pinBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  minimizeBtn: document.getElementById("minimizeBtn"),
  closeBtn: document.getElementById("closeBtn"),
  liquidMeter: document.getElementById("liquidMeter"),
  liquidFill: document.getElementById("liquidFill"),
  remaining: document.getElementById("remaining"),
  remainingLabel: document.getElementById("remainingLabel"),
  dualWeeklyFill: document.getElementById("dualWeeklyFill"),
  dualShortFill: document.getElementById("dualShortFill"),
  dualWeeklyText: document.getElementById("dualWeeklyText"),
  dualShortText: document.getElementById("dualShortText"),
  primaryLabel: document.getElementById("primaryLabel"),
  primaryText: document.getElementById("primaryText"),
  secondaryLabel: document.getElementById("secondaryLabel"),
  secondaryText: document.getElementById("secondaryText"),
  planLabel: document.getElementById("planLabel"),
  planText: document.getElementById("planText"),
  paceTitle: document.getElementById("paceTitle"),
  paceBadge: document.getElementById("paceBadge"),
  weeklyPaceLabel: document.getElementById("weeklyPaceLabel"),
  weeklyPaceText: document.getElementById("weeklyPaceText"),
  actualPaceLabel: document.getElementById("actualPaceLabel"),
  actualPaceText: document.getElementById("actualPaceText"),
  idealPaceLabel: document.getElementById("idealPaceLabel"),
  idealPaceText: document.getElementById("idealPaceText"),
  deltaPaceLabel: document.getElementById("deltaPaceLabel"),
  deltaPaceText: document.getElementById("deltaPaceText"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText")
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
    close: "退出",
    pin: "置顶",
    unpin: "取消置顶",
    compact: "紧凑窗口",
    expand: "展开窗口",
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
    close: "Quit",
    pin: "Pin",
    unpin: "Unpin",
    compact: "Compact",
    expand: "Expand",
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
  if (element) element.textContent = value;
}

function setAttr(element, name, value) {
  if (element) element.setAttribute(name, value);
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
  setText(els.langBtn, state.lang === "zh" ? "EN" : "中");
  renderCompactButton(state.compact);
  setAttr(els.refreshBtn, "title", t("refresh"));
  setAttr(els.refreshBtn, "aria-label", t("refresh"));
  setAttr(els.minimizeBtn, "title", t("hide"));
  setAttr(els.minimizeBtn, "aria-label", t("hide"));
  setAttr(els.closeBtn, "title", t("close"));
  setAttr(els.closeBtn, "aria-label", t("close"));
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
  renderDualMeter(quota);
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
}

function renderDualMeter(quota) {
  const weekly = quota?.paceAdvice?.longWindow;
  const short = quota?.paceAdvice?.shortWindow;
  const weeklyPercent = percentText(weekly?.remainingPercent);
  const shortPercent = percentText(short?.remainingPercent);

  els.dualWeeklyFill.style.height = weeklyPercent;
  els.dualShortFill.style.height = shortPercent;
  setText(els.dualWeeklyText, weeklyPercent);
  setText(els.dualShortText, shortPercent);
}

function renderLoading() {
  renderStaticCopy();
  els.body.dataset.state = "loading";
  els.trafficLight.className = "traffic-light loading";
  els.statusDot.className = "status-dot loading";
  setText(els.stateText, t("loading"));
  setText(els.statusText, t("statusLoading"));
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
  renderDualMeter(null);
  setText(els.primaryText, "--");
  setText(els.secondaryText, "--");
  setText(els.planText, "--");
  renderPaceAdvice(null);
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
  renderLoading();

  try {
    const quota = await window.codexQuota.getQuota();
    renderQuota(quota);
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

function renderCompactButton(isCompact) {
  const label = isCompact ? t("expand") : t("compact");
  els.compactBtn.classList.toggle("active", Boolean(isCompact));
  setAttr(els.compactBtn, "title", label);
  setAttr(els.compactBtn, "aria-label", label);
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

els.refreshBtn.addEventListener("click", refreshQuota);
els.minimizeBtn.addEventListener("click", () => window.codexQuota.minimize());
els.closeBtn.addEventListener("click", () => window.codexQuota.close());
els.pinBtn.addEventListener("click", async () => {
  const next = !els.pinBtn.classList.contains("active");
  const isPinned = await window.codexQuota.setAlwaysOnTop(next);
  renderPin(isPinned);
});

window.codexQuota.onRefresh(refreshQuota);
window.codexQuota.onAlwaysOnTopChanged(renderPin);
window.codexQuota.onCompactChanged(renderCompactMode);

renderLoading();
syncAlwaysOnTop();
syncCompactMode();
refreshQuota();
