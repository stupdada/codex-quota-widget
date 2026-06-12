const PACE_DELTA_THRESHOLD = 15;
const URGENT_PACE_DELTA_MIN = 8;
const URGENT_PACE_DELTA_MAX = 35;
const CRITICAL_REMAINING_PERCENT = 5;
const LONG_WINDOW_MINUTES = 24 * 60;
const VELOCITY_PACE_DELTA_THRESHOLD = 3;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const VELOCITY_WINDOWS_BY_ROLE = {
  long: [30, 2 * 60, 6 * 60, 12 * 60, 24 * 60, 48 * 60],
  short: [15, 30, 60, 120]
};
const VELOCITY_DISPLAY_MIN_MINS_BY_ROLE = {
  long: 30,
  short: 10
};
const VELOCITY_FULL_CONFIDENCE_MINS_BY_ROLE = {
  long: 12 * 60,
  short: 30
};
const VELOCITY_IDEAL_WEIGHT_BY_ROLE = {
  long: 0.1,
  short: 0.3
};
const VELOCITY_RECENT_WEIGHT_BY_ROLE = {
  long: 0.35,
  short: 0.7
};
const VELOCITY_LEARNED_WEIGHT_BY_ROLE = {
  long: 0.45,
  short: 0.05
};
const LEARNED_PROFILE_BUCKET_COUNT = 7 * 24;
const LEARNED_PROFILE_ALPHA = 0.08;
const LEARNED_MAX_INTERVAL_MINS_BY_ROLE = {
  long: 24 * 60,
  short: 3 * 60
};
const OVERALL_SEVERITY_BY_STATUS = {
  urgent: "urgent",
  accelerate: "good",
  normal: "normal",
  recentFast: "warning",
  coolingDown: "warning",
  slow: "danger",
  critical: "danger",
  unknown: "muted"
};

function buildPaceAdvice(snapshot, now = new Date(), history = []) {
  const nowMs = toTimeMs(now);
  const keys = selectWindowKeys(snapshot);
  const longWindow = keys.long ? analyzeWindow(snapshot[keys.long], keys.long, "long", nowMs, history) : null;
  const shortWindow = keys.short ? analyzeWindow(snapshot[keys.short], keys.short, "short", nowMs, history) : null;

  return {
    longWindow,
    shortWindow,
    overall: summarizeOverall(longWindow, shortWindow),
    thresholds: {
      paceDelta: PACE_DELTA_THRESHOLD,
      urgentPaceDeltaMin: URGENT_PACE_DELTA_MIN,
      urgentPaceDeltaMax: URGENT_PACE_DELTA_MAX,
      criticalRemainingPercent: CRITICAL_REMAINING_PERCENT,
      velocityPaceDelta: VELOCITY_PACE_DELTA_THRESHOLD
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

function analyzeWindow(window, key, role, nowMs, history = []) {
  const remainingPercent = clampPercent(Number(window.remainingPercent));
  const durationMins = Number(window.windowDurationMins);
  const resetsAtMs = Date.parse(window.resetsAt || "");
  const canCompare = Number.isFinite(durationMins) && durationMins > 0 && Number.isFinite(resetsAtMs);
  const velocity = analyzeVelocity(window, key, role, nowMs, history);

  let idealRemainingPercent = null;
  let paceDelta = null;
  let status = "unknown";
  let severity = "muted";
  let reasonCode = "insufficientData";

  if (canCompare) {
    const remainingMs = Math.max(0, resetsAtMs - nowMs);
    const windowMs = durationMins * 60 * 1000;
    idealRemainingPercent = clampPercent((remainingMs / windowMs) * 100);
    paceDelta = remainingPercent - idealRemainingPercent;

    if (remainingPercent <= CRITICAL_REMAINING_PERCENT) {
      status = "critical";
      severity = "danger";
      reasonCode = "critical";
    } else if (paceDelta >= PACE_DELTA_THRESHOLD) {
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
  } else if (remainingPercent <= CRITICAL_REMAINING_PERCENT) {
    status = "critical";
    severity = "danger";
    reasonCode = "critical";
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
    velocity,
    windowDurationMins: Number.isFinite(durationMins) ? durationMins : null,
    resetsAt: window.resetsAt || null
  };
}

function analyzeVelocity(window, key, role, nowMs, history) {
  const currentRemaining = clampPercent(Number(window.remainingPercent));
  const resetsAt = window.resetsAt || null;
  const resetsAtMs = Date.parse(resetsAt || "");
  const durationMins = Number(window.windowDurationMins);
  if (!Number.isFinite(currentRemaining) || !Number.isFinite(resetsAtMs)) return null;

  const idealRemainingPercent =
    Number.isFinite(durationMins) && durationMins > 0
      ? clampPercent((Math.max(0, resetsAtMs - nowMs) / (durationMins * MINUTE_MS)) * 100)
      : null;
  const hoursUntilReset = Math.max(0, resetsAtMs - nowMs) / HOUR_MS;
  const historySamples = usableVelocitySamples(history, key, nowMs);
  const currentSample = {
    fetchedAtMs: nowMs,
    remainingPercent: currentRemaining,
    resetsAt,
    windowDurationMins: Number.isFinite(durationMins) ? durationMins : null
  };
  const recentEstimate = estimateRecentVelocity(historySamples, currentSample, role, nowMs);
  const learnedEstimate = estimateLearnedVelocity(historySamples, currentSample, role, nowMs, resetsAtMs);
  const blended = blendVelocityRequirements(role, idealRemainingPercent, recentEstimate, learnedEstimate);
  if (!blended) return null;

  const requiredRemainingPercent = clampPercent(blended.requiredRemainingPercent);
  const projectedRemainingAtResetPercent = currentRemaining - requiredRemainingPercent;
  const effectiveBurnRate = hoursUntilReset > 0 ? requiredRemainingPercent / hoursUntilReset : 0;

  return {
    requiredRemainingPercent: round1(requiredRemainingPercent),
    projectedRemainingAtResetPercent: round1(projectedRemainingAtResetPercent),
    paceDelta: round1(currentRemaining - requiredRemainingPercent),
    burnRatePercentPerHour: round1(recentEstimate?.burnRatePercentPerHour ?? effectiveBurnRate),
    effectiveBurnRatePercentPerHour: round1(effectiveBurnRate),
    sampleWindowMins: recentEstimate ? recentEstimate.sampleWindowMins : 0,
    sampleCount: recentEstimate ? recentEstimate.sampleCount : 0,
    confidence: round2(blended.confidence),
    recentConfidence: round2(recentEstimate?.confidence ?? 0),
    learnedConfidence: round2(learnedEstimate?.confidence ?? 0),
    recentRequiredRemainingPercent:
      recentEstimate?.requiredRemainingPercent === undefined ? null : round1(recentEstimate.requiredRemainingPercent),
    learnedRequiredRemainingPercent:
      learnedEstimate?.requiredRemainingPercent === undefined ? null : round1(learnedEstimate.requiredRemainingPercent),
    idealRequiredRemainingPercent: idealRemainingPercent === null ? null : round1(idealRemainingPercent),
    source: blended.source
  };
}

function usableVelocitySamples(history, key, nowMs) {
  if (!Array.isArray(history)) return [];
  return history
    .map((sample) => {
      const fetchedAtMs = toTimeMs(sample?.fetchedAt);
      const window = sample?.[key];
      const remainingPercent = Number(window?.remainingPercent);
      const windowDurationMins = Number(window?.windowDurationMins);
      return {
        fetchedAtMs,
        remainingPercent,
        resetsAt: window?.resetsAt || null,
        windowDurationMins: Number.isFinite(windowDurationMins) ? windowDurationMins : null
      };
    })
    .filter(
      (sample) =>
        Number.isFinite(sample.fetchedAtMs) &&
        sample.fetchedAtMs < nowMs &&
        Number.isFinite(sample.remainingPercent)
    )
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
}

function estimateRecentVelocity(historySamples, currentSample, role, nowMs) {
  const samples = dedupeSamples([...historySamples, currentSample]).filter(
    (sample) => sample.resetsAt === currentSample.resetsAt
  );
  const maxWindowMins = Math.max(...(VELOCITY_WINDOWS_BY_ROLE[role] || VELOCITY_WINDOWS_BY_ROLE.short));
  const intervals = usageIntervals(samples, { maxGapMins: maxWindowMins });
  if (intervals.length === 0) return null;

  const minElapsedMins = VELOCITY_DISPLAY_MIN_MINS_BY_ROLE[role] || VELOCITY_DISPLAY_MIN_MINS_BY_ROLE.short;
  const estimates = (VELOCITY_WINDOWS_BY_ROLE[role] || VELOCITY_WINDOWS_BY_ROLE.short)
    .map((windowMins) => measureIntervalRate(intervals, nowMs - windowMins * MINUTE_MS, nowMs, minElapsedMins))
    .filter(Boolean);
  if (estimates.length === 0) return null;

  const burnRatePercentPerHour = robustWeightedRate(estimates);
  const hoursUntilReset = Math.max(0, Date.parse(currentSample.resetsAt || "") - nowMs) / HOUR_MS;
  const sampleWindowMins = Math.max(...estimates.map((estimate) => estimate.elapsedMins));
  const fullConfidenceMins =
    VELOCITY_FULL_CONFIDENCE_MINS_BY_ROLE[role] || VELOCITY_FULL_CONFIDENCE_MINS_BY_ROLE.short;
  const confidence = clampRange(sampleWindowMins / fullConfidenceMins, 0, 1);

  return {
    burnRatePercentPerHour,
    requiredRemainingPercent: clampPercent(burnRatePercentPerHour * hoursUntilReset),
    sampleWindowMins: Math.round(sampleWindowMins),
    sampleCount: countSamplesWithin(samples, nowMs, sampleWindowMins * MINUTE_MS),
    confidence,
    estimateCount: estimates.length
  };
}

function estimateLearnedVelocity(historySamples, currentSample, role, nowMs, resetsAtMs) {
  const maxGapMins = LEARNED_MAX_INTERVAL_MINS_BY_ROLE[role] || LEARNED_MAX_INTERVAL_MINS_BY_ROLE.short;
  const intervals = usageIntervals(dedupeSamples([...historySamples, currentSample]), { maxGapMins });
  if (intervals.length === 0) return null;

  const profile = buildHourlyUsageProfile(intervals);
  const projection = projectLearnedUsage(profile, nowMs, resetsAtMs);
  if (!projection) return null;

  return {
    burnRatePercentPerHour: projection.burnRatePercentPerHour,
    requiredRemainingPercent: projection.requiredRemainingPercent,
    confidence: projection.confidence,
    bucketCount: projection.bucketCount
  };
}

function blendVelocityRequirements(role, idealRequired, recentEstimate, learnedEstimate) {
  const parts = [];
  if (idealRequired !== null && idealRequired !== undefined && Number.isFinite(idealRequired)) {
    parts.push({
      name: "ideal",
      value: idealRequired,
      weight: VELOCITY_IDEAL_WEIGHT_BY_ROLE[role] || VELOCITY_IDEAL_WEIGHT_BY_ROLE.short,
      confidence: 0
    });
  }
  if (recentEstimate) {
    parts.push({
      name: "recent",
      value: recentEstimate.requiredRemainingPercent,
      weight: (VELOCITY_RECENT_WEIGHT_BY_ROLE[role] || VELOCITY_RECENT_WEIGHT_BY_ROLE.short) * recentEstimate.confidence,
      confidence: recentEstimate.confidence
    });
  }
  if (learnedEstimate) {
    parts.push({
      name: "learned",
      value: learnedEstimate.requiredRemainingPercent,
      weight:
        (VELOCITY_LEARNED_WEIGHT_BY_ROLE[role] || VELOCITY_LEARNED_WEIGHT_BY_ROLE.short) *
        learnedEstimate.confidence,
      confidence: learnedEstimate.confidence
    });
  }

  const activeParts = parts.filter((part) => part.weight > 0 && Number.isFinite(part.value));
  if (activeParts.length === 0) return null;

  const totalWeight = activeParts.reduce((sum, part) => sum + part.weight, 0);
  const requiredRemainingPercent =
    activeParts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;
  const confidence = Math.max(...activeParts.map((part) => part.confidence));
  const source = activeParts
    .filter((part) => part.name !== "ideal" || activeParts.length === 1)
    .map((part) => part.name)
    .join("+");

  return {
    requiredRemainingPercent,
    confidence,
    source: source || "ideal"
  };
}

function usageIntervals(samples, { maxGapMins }) {
  const sorted = dedupeSamples(samples).sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  const intervals = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.resetsAt !== current.resetsAt) continue;

    const elapsedMs = current.fetchedAtMs - previous.fetchedAtMs;
    if (elapsedMs <= 0 || elapsedMs > maxGapMins * MINUTE_MS) continue;

    const rawBurnedPercent = previous.remainingPercent - current.remainingPercent;
    if (rawBurnedPercent < -0.25) continue;

    intervals.push({
      startMs: previous.fetchedAtMs,
      endMs: current.fetchedAtMs,
      burnedPercent: Math.max(0, rawBurnedPercent),
      elapsedMs
    });
  }
  return intervals;
}

function measureIntervalRate(intervals, startMs, endMs, minElapsedMins) {
  let elapsedMs = 0;
  let burnedPercent = 0;
  let intervalCount = 0;

  for (const interval of intervals) {
    const overlapStart = Math.max(startMs, interval.startMs);
    const overlapEnd = Math.min(endMs, interval.endMs);
    const overlapMs = Math.max(0, overlapEnd - overlapStart);
    if (overlapMs <= 0) continue;

    elapsedMs += overlapMs;
    burnedPercent += interval.burnedPercent * (overlapMs / interval.elapsedMs);
    intervalCount += 1;
  }

  if (elapsedMs < minElapsedMins * MINUTE_MS) return null;

  return {
    burnRatePercentPerHour: burnedPercent / (elapsedMs / HOUR_MS),
    elapsedMins: elapsedMs / MINUTE_MS,
    intervalCount
  };
}

function robustWeightedRate(estimates) {
  const sorted = estimates.slice().sort((a, b) => a.burnRatePercentPerHour - b.burnRatePercentPerHour);
  const trimmed = sorted.length >= 4 ? sorted.slice(1, -1) : sorted;
  const weighted = trimmed.map((estimate) => ({
    rate: estimate.burnRatePercentPerHour,
    weight: Math.sqrt(Math.max(1, estimate.elapsedMins))
  }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  return weighted.reduce((sum, item) => sum + item.rate * item.weight, 0) / totalWeight;
}

function buildHourlyUsageProfile(intervals) {
  const buckets = Array.from({ length: LEARNED_PROFILE_BUCKET_COUNT }, () => ({
    rate: null,
    weight: 0,
    observations: 0
  }));
  const profile = {
    buckets,
    globalRate: null,
    globalWeight: 0
  };

  for (const interval of intervals) {
    const durationHours = interval.elapsedMs / HOUR_MS;
    if (durationHours <= 0) continue;

    const observedRate = interval.burnedPercent / durationHours;
    const globalAlpha = learnedAlpha(durationHours);
    profile.globalRate = ema(profile.globalRate, observedRate, globalAlpha);
    profile.globalWeight = clampRange(profile.globalWeight + globalAlpha, 0, 1);

    forEachLocalHourSegment(interval.startMs, interval.endMs, (bucketIndex, hours) => {
      const bucket = buckets[bucketIndex];
      const bucketAlpha = learnedAlpha(hours);
      bucket.rate = ema(bucket.rate, observedRate, bucketAlpha);
      bucket.weight = clampRange(bucket.weight + bucketAlpha, 0, 1);
      bucket.observations += 1;
    });
  }

  return profile;
}

function projectLearnedUsage(profile, nowMs, resetsAtMs) {
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs || !Number.isFinite(profile.globalRate)) return null;

  let totalHours = 0;
  let expectedBurn = 0;
  let confidenceHours = 0;
  const seenBuckets = new Set();

  forEachLocalHourSegment(nowMs, resetsAtMs, (bucketIndex, hours) => {
    const bucket = profile.buckets[bucketIndex];
    const hasBucketRate = Number.isFinite(bucket.rate);
    const rate = hasBucketRate ? bucket.rate : profile.globalRate;
    const bucketConfidence = hasBucketRate
      ? clampRange(bucket.weight * 4, 0, 1)
      : clampRange(profile.globalWeight * 0.2, 0, 0.25);

    expectedBurn += rate * hours;
    confidenceHours += bucketConfidence * hours;
    totalHours += hours;
    if (hasBucketRate) seenBuckets.add(bucketIndex);
  });

  if (totalHours <= 0) return null;

  return {
    requiredRemainingPercent: clampPercent(expectedBurn),
    burnRatePercentPerHour: expectedBurn / totalHours,
    confidence: clampRange(confidenceHours / totalHours, 0, 1),
    bucketCount: seenBuckets.size
  };
}

function forEachLocalHourSegment(startMs, endMs, callback) {
  let cursor = startMs;
  while (cursor < endMs) {
    const date = new Date(cursor);
    const nextHour = new Date(date);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const segmentEndMs = Math.min(endMs, nextHour.getTime());
    const hours = (segmentEndMs - cursor) / HOUR_MS;
    callback(localHourBucketIndex(date), hours);
    cursor = segmentEndMs;
  }
}

function localHourBucketIndex(date) {
  return date.getDay() * 24 + date.getHours();
}

function learnedAlpha(hours) {
  return clampRange(LEARNED_PROFILE_ALPHA * Math.max(1, Math.sqrt(hours)), 0.02, 0.2);
}

function ema(current, observed, alpha) {
  return Number.isFinite(current) ? current * (1 - alpha) + observed * alpha : observed;
}

function dedupeSamples(samples) {
  const byTime = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample?.fetchedAtMs) || !Number.isFinite(sample?.remainingPercent)) continue;
    byTime.set(sample.fetchedAtMs, {
      fetchedAtMs: sample.fetchedAtMs,
      remainingPercent: clampPercent(sample.remainingPercent),
      resetsAt: sample.resetsAt || null,
      windowDurationMins: Number.isFinite(sample.windowDurationMins) ? sample.windowDurationMins : null
    });
  }
  return Array.from(byTime.values()).sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
}

function countSamplesWithin(samples, nowMs, maxAgeMs) {
  return samples.filter((sample) => nowMs - sample.fetchedAtMs <= maxAgeMs).length;
}

function summarize(window, source) {
  return {
    status: window.status,
    severity: OVERALL_SEVERITY_BY_STATUS[window.status] || window.severity,
    reasonCode: window.reasonCode,
    source
  };
}

function summarizeStatus(status, reasonCode, source) {
  return {
    status,
    severity: OVERALL_SEVERITY_BY_STATUS[status] || "muted",
    reasonCode,
    source
  };
}

function summarizeOverall(longWindow, shortWindow) {
  if (!longWindow) {
    return summarizeStatus("unknown", "missingLongWindow", "long");
  }

  if (longWindow.status === "critical" || longWindow.status === "unknown") {
    return summarize(longWindow, "long");
  }

  if (shortWindow?.status === "critical") {
    return summarizeStatus("critical", "shortWindowCritical", "short");
  }

  const dynamicSummary = summarizeDynamicOverall(longWindow, shortWindow);
  if (dynamicSummary) return dynamicSummary;

  if (longWindow.status === "slow") {
    if (shortWindow?.status === "slow") {
      return summarizeStatus("slow", "bothWindowsBehind", "combined");
    }
    if (shortWindow?.status === "normal" || shortWindow?.status === "accelerate") {
      return summarizeStatus("coolingDown", "recentPaceRecovered", "combined");
    }
    return summarizeStatus("slow", "behind", "long");
  }

  if (shortWindow?.status === "slow") {
    return summarizeStatus("recentFast", "shortWindowTight", "short");
  }

  const urgentThreshold = urgentPaceDeltaThreshold(longWindow);
  if (urgentThreshold !== null && longWindow.paceDelta >= urgentThreshold) {
    return summarizeStatus("urgent", "urgentAhead", "combined");
  }

  return summarize(longWindow, "long");
}

function summarizeDynamicOverall(longWindow, shortWindow) {
  const dynamicDelta = dynamicPaceDelta(longWindow);
  if (dynamicDelta === null) return null;

  const idealDelta = Number(longWindow.paceDelta);
  if (!Number.isFinite(idealDelta)) return null;

  const shortDynamicDelta = dynamicPaceDelta(shortWindow);
  const shortHasPressure =
    shortWindow?.status === "slow" ||
    (shortDynamicDelta !== null && shortDynamicDelta <= -VELOCITY_PACE_DELTA_THRESHOLD);

  if (shortHasPressure && idealDelta >= -PACE_DELTA_THRESHOLD) {
    return summarizeStatus("recentFast", "shortWindowTight", "short");
  }

  const idealBehind = idealDelta <= -PACE_DELTA_THRESHOLD;
  const dynamicBehind = dynamicDelta <= -VELOCITY_PACE_DELTA_THRESHOLD;
  if (!idealBehind && dynamicBehind) {
    return summarizeStatus("recentFast", "dynamicPaceTight", "combined");
  }
  if (idealBehind && !dynamicBehind) {
    return summarizeStatus("coolingDown", "recentPaceRecovered", "combined");
  }
  if (idealBehind && dynamicBehind) {
    if (shortWindow?.status === "slow") {
      return summarizeStatus("slow", "bothWindowsBehind", "combined");
    }
    return summarizeStatus("slow", "bothReferencesBehind", "combined");
  }

  const urgentThreshold = urgentPaceDeltaThreshold(longWindow);
  if (
    urgentThreshold !== null &&
    idealDelta >= urgentThreshold &&
    dynamicDelta >= VELOCITY_PACE_DELTA_THRESHOLD &&
    !shortHasPressure
  ) {
    return summarizeStatus("urgent", "urgentAhead", "combined");
  }

  if (idealDelta >= PACE_DELTA_THRESHOLD && dynamicDelta >= VELOCITY_PACE_DELTA_THRESHOLD) {
    return summarizeStatus("accelerate", "ahead", "combined");
  }

  return summarizeStatus("normal", "onTrack", "combined");
}

function dynamicPaceDelta(window) {
  const value = Number(window?.velocity?.paceDelta);
  return Number.isFinite(value) ? value : null;
}

function urgentPaceDeltaThreshold(longWindow) {
  if (longWindow?.idealRemainingPercent === null || longWindow?.idealRemainingPercent === undefined) return null;
  const timeLeft = Number(longWindow?.idealRemainingPercent);
  if (!Number.isFinite(timeLeft)) return null;
  return round1(clampRange(timeLeft * 0.5 + 5, URGENT_PACE_DELTA_MIN, URGENT_PACE_DELTA_MAX));
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

function clampRange(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  buildPaceAdvice,
  analyzeWindow,
  analyzeVelocity,
  selectWindowKeys,
  urgentPaceDeltaThreshold,
  PACE_DELTA_THRESHOLD,
  URGENT_PACE_DELTA_MIN,
  URGENT_PACE_DELTA_MAX,
  CRITICAL_REMAINING_PERCENT,
  VELOCITY_PACE_DELTA_THRESHOLD
};
