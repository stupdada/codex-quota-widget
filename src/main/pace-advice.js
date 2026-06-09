const PACE_DELTA_THRESHOLD = 15;
const CRITICAL_REMAINING_PERCENT = 5;
const LONG_WINDOW_MINUTES = 24 * 60;

function buildPaceAdvice(snapshot, now = new Date()) {
  const nowMs = toTimeMs(now);
  const keys = selectWindowKeys(snapshot);
  const longWindow = keys.long ? analyzeWindow(snapshot[keys.long], keys.long, "long", nowMs) : null;
  const shortWindow = keys.short ? analyzeWindow(snapshot[keys.short], keys.short, "short", nowMs) : null;

  return {
    longWindow,
    shortWindow,
    overall: longWindow
      ? summarize(longWindow, "long")
      : {
          status: "unknown",
          severity: "muted",
          reasonCode: "missingLongWindow",
          source: "long"
        },
    thresholds: {
      paceDelta: PACE_DELTA_THRESHOLD,
      criticalRemainingPercent: CRITICAL_REMAINING_PERCENT
    }
  };
}

function selectWindowKeys(snapshot) {
  const entries = [
    ["primary", snapshot?.primary],
    ["secondary", snapshot?.secondary]
  ].filter(([, window]) => Boolean(window));

  const windowsWithDuration = entries.filter(([, window]) => Number.isFinite(Number(window.windowDurationMins)));
  const longest = windowsWithDuration.reduce((current, entry) => {
    if (!current) return entry;
    return Number(entry[1].windowDurationMins) > Number(current[1].windowDurationMins) ? entry : current;
  }, null);

  let long = null;
  if (longest && Number(longest[1].windowDurationMins) >= LONG_WINDOW_MINUTES) {
    long = longest[0];
  } else if (snapshot?.secondary) {
    long = "secondary";
  }

  let short = null;
  const shortByDuration = windowsWithDuration.find(
    ([key, window]) => key !== long && Number(window.windowDurationMins) < LONG_WINDOW_MINUTES
  );
  if (shortByDuration) {
    short = shortByDuration[0];
  } else if (snapshot?.primary && long !== "primary") {
    short = "primary";
  } else if (snapshot?.secondary && long !== "secondary") {
    short = "secondary";
  }

  return { long, short };
}

function analyzeWindow(window, key, role, nowMs) {
  const remainingPercent = clampPercent(Number(window.remainingPercent));
  const durationMins = Number(window.windowDurationMins);
  const resetsAtMs = Date.parse(window.resetsAt || "");
  const canCompare = Number.isFinite(durationMins) && durationMins > 0 && Number.isFinite(resetsAtMs);

  let idealRemainingPercent = null;
  let paceDelta = null;
  let status = "unknown";
  let severity = "muted";
  let reasonCode = "insufficientData";

  if (remainingPercent <= CRITICAL_REMAINING_PERCENT) {
    status = "critical";
    severity = "danger";
    reasonCode = "critical";
  } else if (canCompare) {
    const remainingMs = Math.max(0, resetsAtMs - nowMs);
    const windowMs = durationMins * 60 * 1000;
    idealRemainingPercent = clampPercent((remainingMs / windowMs) * 100);
    paceDelta = remainingPercent - idealRemainingPercent;

    if (paceDelta >= PACE_DELTA_THRESHOLD) {
      status = "accelerate";
      severity = "good";
      reasonCode = "ahead";
    } else if (paceDelta <= -PACE_DELTA_THRESHOLD) {
      status = "slow";
      severity = "warning";
      reasonCode = "behind";
    } else {
      status = "normal";
      severity = "good";
      reasonCode = "onTrack";
    }
  }

  return {
    key,
    role,
    status,
    severity,
    reasonCode,
    remainingPercent: round1(remainingPercent),
    idealRemainingPercent: idealRemainingPercent === null ? null : round1(idealRemainingPercent),
    paceDelta: paceDelta === null ? null : round1(paceDelta),
    windowDurationMins: Number.isFinite(durationMins) ? durationMins : null,
    resetsAt: window.resetsAt || null
  };
}

function summarize(window, source) {
  return {
    status: window.status,
    severity: window.severity,
    reasonCode: window.reasonCode,
    source
  };
}

function toTimeMs(value) {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : Date.now();
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  buildPaceAdvice,
  analyzeWindow,
  selectWindowKeys,
  PACE_DELTA_THRESHOLD,
  CRITICAL_REMAINING_PERCENT
};
