const SIGNAL_LEVELS = Object.freeze({
  unavailable: 0,
  healthy: 1,
  abundant: 1,
  stale: 2,
  behind: 2,
  low: 3,
  critical: 4
});

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function idealRemainingPercent(cycle) {
  const resetAt = Date.parse(cycle?.resetAt || "");
  const observedAt = Date.parse(cycle?.observedAt || "");
  const windowMinutes = finiteNumberOrNull(cycle?.windowMinutes);
  if (!Number.isFinite(resetAt) || !Number.isFinite(observedAt) || !windowMinutes || windowMinutes <= 0) {
    return null;
  }
  return clampPercent(((resetAt - observedAt) / (windowMinutes * 60 * 1000)) * 100);
}

function normalizeCycle(rawCycle, generatedAt) {
  if (!rawCycle || typeof rawCycle !== "object") return null;
  const remainingPercent = clampPercent(rawCycle.remaining_percent ?? rawCycle.remainingPercent);
  if (remainingPercent === null) return null;
  const resetAt = isoOrNull(rawCycle.reset_at ?? rawCycle.resetAt);
  const observedAt = isoOrNull(rawCycle.observed_at ?? rawCycle.observedAt ?? generatedAt);
  const windowMinutes = finiteNumberOrNull(rawCycle.window_minutes ?? rawCycle.windowMinutes);
  const cycle = {
    remainingPercent,
    usedPercent: clampPercent(rawCycle.used_percent ?? rawCycle.usedPercent) ?? 100 - remainingPercent,
    resetAt,
    windowMinutes,
    observedAt,
    stale: Boolean(rawCycle.stale)
  };
  cycle.idealRemainingPercent = idealRemainingPercent(cycle);
  cycle.delta = cycle.idealRemainingPercent === null ? null : cycle.remainingPercent - cycle.idealRemainingPercent;
  return cycle;
}

function cycleSignal(cycle) {
  if (!cycle) return "unavailable";
  if (cycle.remainingPercent <= 5) return "critical";
  if (cycle.remainingPercent <= 10) return "low";
  if (cycle.stale) return "stale";
  if (cycle.delta !== null && cycle.delta <= -10) return "behind";
  if (cycle.delta !== null && cycle.delta >= 15) return "abundant";
  return "healthy";
}

function signalCopy(status) {
  const values = {
    unavailable: { severity: "muted", label: "额度不可用", detail: "Token 仪表盘服务未提供额度数据", animation: "steady" },
    stale: { severity: "warning", label: "额度已过期", detail: "额度数据已过期，正在等待刷新", animation: "breathe" },
    critical: { severity: "danger", label: "接近耗尽", detail: "至少一个额度窗口剩余不高于 5%", animation: "blink" },
    low: { severity: "warning", label: "额度偏低", detail: "至少一个额度窗口剩余不高于 10%", animation: "breathe" },
    behind: { severity: "warning", label: "低于理想", detail: "实际剩余额度低于线性理想剩余 10 个百分点以上", animation: "breathe" },
    abundant: { severity: "good", label: "余量充足", detail: "实际剩余额度高于线性理想剩余", animation: "steady" },
    healthy: { severity: "normal", label: "额度正常", detail: "额度剩余与线性理想进度基本一致", animation: "steady" }
  };
  return { status, ...values[status] };
}

function deriveQuotaSignal(cycles, options = {}) {
  const fiveHour = cycles?.fiveHour || null;
  const sevenDay = cycles?.sevenDay || null;
  if (options.connectionUnavailable) {
    return signalCopy(fiveHour || sevenDay ? "stale" : "unavailable");
  }
  const availableCycles = [fiveHour, sevenDay].filter(Boolean);
  if (!availableCycles.length) return signalCopy("unavailable");
  const statuses = availableCycles.map(cycleSignal);
  const status = statuses.reduce((worst, current) =>
    SIGNAL_LEVELS[current] > SIGNAL_LEVELS[worst] ? current : worst
  );
  return signalCopy(status);
}

module.exports = {
  clampPercent,
  deriveQuotaSignal,
  idealRemainingPercent,
  normalizeCycle
};
