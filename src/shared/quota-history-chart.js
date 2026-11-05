const SERIES_META = {
  primary: {
    label: "5 小时窗口",
    color: "#d24b42"
  },
  secondary: {
    label: "7 天窗口",
    color: "#2477a8"
  },
  longIdeal: {
    label: "7 天理想线",
    color: "#7b8794",
    valueKind: "idealRemainingPercent"
  },
  longVelocityRequired: {
    label: "7 天近速需留",
    color: "#22a9c9",
    valueKind: "requiredRemainingPercent"
  }
};
const LONG_WINDOW_MINUTES = 24 * 60;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function normalizeQuotaHistoryPayload(payload) {
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  return samples
    .map((sample) => {
      const fetchedAtMs = Date.parse(sample?.fetchedAt || "");
      if (!Number.isFinite(fetchedAtMs)) return null;
      const primary = normalizeWindow(sample?.primary);
      const secondary = normalizeWindow(sample?.secondary);
      if (!primary && !secondary) return null;
      return {
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        fetchedAtMs,
        primary,
        secondary,
        paceAdvice: sample?.paceAdvice || null
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
}

function normalizeWindow(window) {
  if (!window) return null;
  const remainingPercent = Number(window.remainingPercent);
  if (!Number.isFinite(remainingPercent)) return null;
  return {
    remainingPercent: clampPercent(remainingPercent),
    windowDurationMins: Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null,
    resetsAt: window.resetsAt || null
  };
}

function buildChartSeries(samples, plotBox) {
  const normalized = normalizeQuotaHistoryPayload({ samples });
  if (normalized.length === 0) {
    return {
      samples: [],
      minTimeMs: null,
      maxTimeMs: null,
      plotBox,
      series: {
        primary: { ...SERIES_META.primary, points: [] },
        secondary: { ...SERIES_META.secondary, points: [] },
        longIdeal: { ...SERIES_META.longIdeal, points: [] },
        longVelocityRequired: { ...SERIES_META.longVelocityRequired, points: [] }
      },
      xScale: () => plotBox.x,
      yScale: (percent) => plotBox.y + (1 - clampPercent(percent) / 100) * plotBox.height
    };
  }

  const minTimeMs = normalized[0].fetchedAtMs;
  const maxTimeMs = normalized[normalized.length - 1].fetchedAtMs;
  const timeSpanMs = Math.max(1, maxTimeMs - minTimeMs);
  const scaleX = (timeMs) => plotBox.x + ((timeMs - minTimeMs) / timeSpanMs) * plotBox.width;
  const scaleY = (percent) => plotBox.y + (1 - clampPercent(percent) / 100) * plotBox.height;
  const velocityRequiredByTime = rawVelocityRequiredPercentByTime(normalized);

  return {
    samples: normalized,
    minTimeMs,
    maxTimeMs,
    plotBox,
    series: {
      primary: buildSeriesPoints(normalized, "primary", scaleX, scaleY),
      secondary: buildSeriesPoints(normalized, "secondary", scaleX, scaleY),
      longIdeal: buildReferenceSeriesPoints(
        normalized,
        "longIdeal",
        (sample) => sample?.paceAdvice?.longWindow?.idealRemainingPercent ?? idealRemainingPercentForSample(sample),
        scaleX,
        scaleY
      ),
      longVelocityRequired: buildReferenceSeriesPoints(
        normalized,
        "longVelocityRequired",
        (sample) => sample?.paceAdvice?.longWindow?.velocity?.requiredRemainingPercent ?? velocityRequiredByTime.get(sample.fetchedAtMs),
        scaleX,
        scaleY
      )
    },
    xScale: scaleX,
    yScale: scaleY
  };

  function yScale(percent) {
    return scaleY(percent);
  }
}

function buildSeriesPoints(samples, key, scaleX, scaleY) {
  return {
    ...SERIES_META[key],
    points: samples
      .filter((sample) => sample[key])
      .map((sample) => ({
        x: scaleX(sample.fetchedAtMs),
        y: scaleY(sample[key].remainingPercent),
        fetchedAt: sample.fetchedAt,
        fetchedAtMs: sample.fetchedAtMs,
        remainingPercent: sample[key].remainingPercent,
        resetsAt: sample[key].resetsAt,
        valueKind: "remainingPercent",
        seriesKey: key,
        label: SERIES_META[key].label,
        color: SERIES_META[key].color
      }))
  };
}

function buildReferenceSeriesPoints(samples, key, valueSelector, scaleX, scaleY) {
  const meta = SERIES_META[key];
  return {
    ...meta,
    points: samples
      .map((sample) => {
        const remainingPercent = Number(valueSelector(sample));
        if (!Number.isFinite(remainingPercent)) return null;
        return {
          x: scaleX(sample.fetchedAtMs),
          y: scaleY(remainingPercent),
          fetchedAt: sample.fetchedAt,
          fetchedAtMs: sample.fetchedAtMs,
          remainingPercent: clampPercent(remainingPercent),
          resetsAt: longQuotaWindow(sample)?.resetsAt || null,
          valueKind: meta.valueKind,
          seriesKey: key,
          label: meta.label,
          color: meta.color
        };
      })
      .filter(Boolean)
  };
}

function longQuotaWindow(sample) {
  const windows = [sample?.primary, sample?.secondary]
    .filter(Boolean)
    .sort((a, b) => Number(b.windowDurationMins) - Number(a.windowDurationMins));
  return windows.find((window) => Number(window.windowDurationMins) >= LONG_WINDOW_MINUTES) || sample?.secondary || sample?.primary || null;
}

function idealRemainingPercentForSample(sample) {
  const window = longQuotaWindow(sample);
  if (!window) return null;
  const resetsAtMs = Date.parse(window.resetsAt || "");
  const durationMins = Number(window.windowDurationMins);
  if (!Number.isFinite(sample?.fetchedAtMs) || !Number.isFinite(resetsAtMs) || !Number.isFinite(durationMins) || durationMins <= 0) {
    return null;
  }
  return clampPercent(((resetsAtMs - sample.fetchedAtMs) / (durationMins * MINUTE_MS)) * 100);
}

function rawVelocityRequiredPercentByTime(samples) {
  const requiredByTime = new Map();
  let previous = null;

  for (const sample of samples) {
    const window = longQuotaWindow(sample);
    const remainingPercent = Number(window?.remainingPercent);
    const resetsAt = window?.resetsAt || null;
    const resetsAtMs = Date.parse(resetsAt || "");

    if (!Number.isFinite(sample?.fetchedAtMs) || !Number.isFinite(remainingPercent) || !Number.isFinite(resetsAtMs)) {
      continue;
    }

    if (
      previous &&
      previous.resetsAt === resetsAt &&
      sample.fetchedAtMs > previous.fetchedAtMs &&
      remainingPercent < previous.remainingPercent
    ) {
      const elapsedHours = (sample.fetchedAtMs - previous.fetchedAtMs) / HOUR_MS;
      const burnedPercent = previous.remainingPercent - remainingPercent;
      const hoursUntilReset = Math.max(0, resetsAtMs - sample.fetchedAtMs) / HOUR_MS;
      if (elapsedHours > 0 && burnedPercent > 0 && hoursUntilReset > 0) {
        requiredByTime.set(sample.fetchedAtMs, clampPercent((burnedPercent / elapsedHours) * hoursUntilReset));
      }
    }

    previous = {
      fetchedAtMs: sample.fetchedAtMs,
      remainingPercent,
      resetsAt
    };
  }

  return requiredByTime;
}

function displayPointsForPath(points, minDistancePx = 9) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];
  const result = [points[0]];
  let last = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (Math.hypot(point.x - last.x, point.y - last.y) < minDistancePx) continue;
    result.push(point);
    last = point;
  }
  const finalPoint = points[points.length - 1];
  if (result[result.length - 1] !== finalPoint) result.push(finalPoint);
  return result;
}

function collapseSameXPoints(points, bucketSizePx = 2, mode = "last") {
  if (!Array.isArray(points) || points.length <= 1) return points || [];
  const safeBucketSizePx = Number.isFinite(Number(bucketSizePx)) && Number(bucketSizePx) > 0 ? Number(bucketSizePx) : 2;
  const buckets = [];
  let currentBucketKey = null;
  let currentBucket = [];

  for (const point of points) {
    const bucketKey = Math.round(Number(point.x) / safeBucketSizePx);
    if (!Number.isFinite(bucketKey)) continue;
    if (currentBucket.length > 0 && bucketKey !== currentBucketKey) {
      buckets.push(currentBucket);
      currentBucket = [];
    }
    currentBucketKey = bucketKey;
    currentBucket.push(point);
  }
  if (currentBucket.length > 0) buckets.push(currentBucket);

  return buckets.map((bucket) => representativePoint(bucket, mode));
}

function representativePoint(bucket, mode) {
  if (bucket.length === 1) return bucket[0];
  if (mode === "median") {
    const sorted = [...bucket].sort((a, b) => Number(a.remainingPercent) - Number(b.remainingPercent));
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      ...median,
      x: median.x,
      y: median.y,
      fetchedAt: bucket[bucket.length - 1].fetchedAt,
      fetchedAtMs: bucket[bucket.length - 1].fetchedAtMs
    };
  }
  return bucket[bucket.length - 1];
}

function smoothSvgPath(points) {
  if (!Array.isArray(points) || points.length === 0) return "";
  if (points.length === 1) return `M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`;
  if (points.length === 2) {
    return `M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)} L ${formatNumber(points[1].x)} ${formatNumber(points[1].y)}`;
  }

  const commands = [`M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = {
      x: p1.x + (p2.x - p0.x) / 6,
      y: p1.y + (p2.y - p0.y) / 6
    };
    const c2 = {
      x: p2.x - (p3.x - p1.x) / 6,
      y: p2.y - (p3.y - p1.y) / 6
    };
    commands.push(
      `C ${formatNumber(c1.x)} ${formatNumber(c1.y)} ${formatNumber(c2.x)} ${formatNumber(c2.y)} ${formatNumber(p2.x)} ${formatNumber(p2.y)}`
    );
  }
  return commands.join(" ");
}

function lineSvgPath(points) {
  if (!Array.isArray(points) || points.length === 0) return "";
  const commands = [`M ${formatNumber(points[0].x)} ${formatNumber(points[0].y)}`];
  for (let index = 1; index < points.length; index += 1) {
    commands.push(`L ${formatNumber(points[index].x)} ${formatNumber(points[index].y)}`);
  }
  return commands.join(" ");
}

function seriesPathSegments(points, { bucketSizePx = 2, bucketMode = "last", minDistancePx = 9 } = {}) {
  const pathPoints = displayPointsForPath(collapseSameXPoints(points, bucketSizePx, bucketMode), minDistancePx);
  return pathPoints.length === 0 ? [] : [pathPoints];
}

function resetLineSeriesKeys(visibleSeries = {}) {
  return visibleSeries.secondary ? ["secondary"] : [];
}

function nearestSeriesPoint(series, position, maxDistancePx = 40) {
  if (!series || !position) return null;
  const candidates = Object.entries(series)
    .flatMap(([seriesKey, item]) =>
      (item?.points || []).map((point) => ({
        ...point,
        seriesKey,
        label: item.label || point.label,
        color: item.color || point.color,
        distancePx: Math.hypot(point.x - position.x, point.y - position.y)
      }))
    )
    .filter((point) => Number.isFinite(point.distancePx))
    .sort((a, b) => a.distancePx - b.distancePx);

  const nearest = candidates[0] || null;
  if (!nearest || nearest.distancePx > maxDistancePx) return null;
  return nearest;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function formatNumber(value) {
  return Number(value.toFixed(2)).toString();
}

const quotaHistoryChartApi = {
  SERIES_META,
  normalizeQuotaHistoryPayload,
  buildChartSeries,
  collapseSameXPoints,
  displayPointsForPath,
  lineSvgPath,
  resetLineSeriesKeys,
  seriesPathSegments,
  smoothSvgPath,
  nearestSeriesPoint
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = quotaHistoryChartApi;
} else if (typeof window !== "undefined") {
  window.CodexQuotaHistoryChart = quotaHistoryChartApi;
}
