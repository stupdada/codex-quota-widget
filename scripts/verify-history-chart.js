const assert = require("node:assert/strict");
const {
  normalizeQuotaHistoryPayload,
  buildChartSeries,
  collapseSameXPoints,
  lineSvgPath,
  resetLineSeriesKeys,
  seriesPathSegments,
  nearestSeriesPoint
} = require("../src/shared/quota-history-chart");

const payload = {
  version: 1,
  samples: [
    {
      fetchedAt: "2026-06-14T00:00:00.000Z",
      primary: { remainingPercent: 80, windowDurationMins: 300, resetsAt: "2026-06-14T05:00:00.000Z" },
      secondary: { remainingPercent: 95, windowDurationMins: 10080, resetsAt: "2026-06-18T00:00:00.000Z" },
      paceAdvice: {
        longWindow: {
          idealRemainingPercent: 80,
          velocity: { requiredRemainingPercent: 88 }
        }
      }
    },
    {
      fetchedAt: "2026-06-14T01:00:00.000Z",
      primary: { remainingPercent: 60, windowDurationMins: 300, resetsAt: "2026-06-14T05:00:00.000Z" },
      secondary: { remainingPercent: 94, windowDurationMins: 10080, resetsAt: "2026-06-18T00:00:00.000Z" },
      paceAdvice: {
        longWindow: {
          idealRemainingPercent: 70,
          velocity: { requiredRemainingPercent: 84 }
        }
      }
    },
    {
      fetchedAt: "not-a-date",
      primary: { remainingPercent: 10 },
      secondary: { remainingPercent: 10 }
    },
    {
      fetchedAt: "2026-06-14T02:00:00.000Z",
      primary: { remainingPercent: 40, windowDurationMins: 300, resetsAt: "2026-06-14T05:00:00.000Z" },
      secondary: { remainingPercent: 92, windowDurationMins: 10080, resetsAt: "2026-06-18T00:00:00.000Z" },
      paceAdvice: {
        longWindow: {
          idealRemainingPercent: 60,
          velocity: { requiredRemainingPercent: 78 }
        }
      }
    }
  ]
};

function verifyNormalizesHistorySamples() {
  const samples = normalizeQuotaHistoryPayload(payload);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].primary.remainingPercent, 80);
  assert.equal(samples[2].secondary.remainingPercent, 92);
}

function verifyBuildsScaledSeries() {
  const samples = normalizeQuotaHistoryPayload(payload);
  const chart = buildChartSeries(samples, { x: 100, y: 50, width: 600, height: 300 });
  assert.equal(chart.series.primary.points.length, 3);
  assert.equal(chart.series.secondary.points.length, 3);
  assert.equal(chart.series.longIdeal.points.length, 3);
  assert.equal(chart.series.longVelocityRequired.points.length, 3);
  assert.equal(chart.yScale(100), 50);
  assert.equal(chart.yScale(0), 350);
  assert.equal(chart.xScale(Date.parse("2026-06-14T01:00:00.000Z")), 400);
}

function verifyLinePathUsesStraightSegments() {
  const samples = normalizeQuotaHistoryPayload(payload);
  const chart = buildChartSeries(samples, { x: 100, y: 50, width: 600, height: 300 });
  const path = lineSvgPath(chart.series.primary.points);
  assert.match(path, /^M 100 110 L /);
  assert.doesNotMatch(path, /\sC\s/);
  assert.ok(path.includes(" 400 170 "));
  assert.ok(path.endsWith("700 230"));
}

function verifyBuildsIdealLineFromRawHistory() {
  const rawPayload = {
    version: 1,
    samples: [
      {
        fetchedAt: "2026-06-14T00:00:00.000Z",
        secondary: { remainingPercent: 95, windowDurationMins: 600, resetsAt: "2026-06-14T05:00:00.000Z" }
      },
      {
        fetchedAt: "2026-06-14T01:00:00.000Z",
        secondary: { remainingPercent: 94, windowDurationMins: 600, resetsAt: "2026-06-14T05:00:00.000Z" }
      }
    ]
  };
  const samples = normalizeQuotaHistoryPayload(rawPayload);
  const chart = buildChartSeries(samples, { x: 100, y: 50, width: 600, height: 300 });
  assert.equal(chart.series.longIdeal.points.length, 2);
  assert.equal(chart.series.longIdeal.points[0].remainingPercent, 50);
  assert.equal(chart.series.longIdeal.points[1].remainingPercent, 40);
}

function verifyBuildsVelocityLineFromRawHistory() {
  const rawPayload = {
    version: 1,
    samples: [
      {
        fetchedAt: "2026-06-14T00:00:00.000Z",
        secondary: { remainingPercent: 95, windowDurationMins: 600, resetsAt: "2026-06-14T05:00:00.000Z" }
      },
      {
        fetchedAt: "2026-06-14T01:00:00.000Z",
        secondary: { remainingPercent: 90, windowDurationMins: 600, resetsAt: "2026-06-14T05:00:00.000Z" }
      },
      {
        fetchedAt: "2026-06-14T02:00:00.000Z",
        secondary: { remainingPercent: 85, windowDurationMins: 600, resetsAt: "2026-06-14T05:00:00.000Z" }
      }
    ]
  };
  const samples = normalizeQuotaHistoryPayload(rawPayload);
  const chart = buildChartSeries(samples, { x: 100, y: 50, width: 600, height: 300 });
  assert.equal(chart.series.longVelocityRequired.points.length, 2);
  assert.equal(chart.series.longVelocityRequired.points[0].remainingPercent, 20);
  assert.equal(chart.series.longVelocityRequired.points[1].remainingPercent, 15);
}

function verifyConnectsLinesAcrossMissingSamplesAndResetBoundaries() {
  const samples = normalizeQuotaHistoryPayload({
    version: 1,
    samples: [
      {
        fetchedAt: "2026-06-14T00:00:00.000Z",
        primary: { remainingPercent: 20, windowDurationMins: 300, resetsAt: "2026-06-14T01:00:00.000Z" }
      },
      {
        fetchedAt: "2026-06-14T00:30:00.000Z",
        primary: { remainingPercent: 10, windowDurationMins: 300, resetsAt: "2026-06-14T01:00:00.000Z" }
      },
      {
        fetchedAt: "2026-06-14T01:01:00.000Z",
        primary: { remainingPercent: 100, windowDurationMins: 300, resetsAt: "2026-06-14T06:00:00.000Z" }
      }
    ]
  });
  const chart = buildChartSeries(samples, { x: 100, y: 50, width: 600, height: 300 });
  const segments = seriesPathSegments(chart.series.primary.points, {
    bucketSizePx: 2,
    bucketMode: "last",
    minDistancePx: 0
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, 3);
  const path = lineSvgPath(segments[0]);
  assert.equal((path.match(/\bM\b/g) || []).length, 1);
  assert.equal((path.match(/\bL\b/g) || []).length, 2);
}

function verifyResetLinesDoNotUseFiveHourWindow() {
  assert.deepEqual(resetLineSeriesKeys({ primary: true, secondary: true }), ["secondary"]);
  assert.deepEqual(resetLineSeriesKeys({ primary: true, secondary: false }), []);
}

function verifyCollapsesSameXPoints() {
  const points = [
    { x: 10.1, y: 100, remainingPercent: 80, fetchedAtMs: 1000 },
    { x: 10.8, y: 200, remainingPercent: 60, fetchedAtMs: 2000 },
    { x: 12.7, y: 120, remainingPercent: 76, fetchedAtMs: 3000 }
  ];
  const last = collapseSameXPoints(points, 2, "last");
  assert.equal(last.length, 2);
  assert.equal(last[0].remainingPercent, 60);
  assert.equal(last[0].fetchedAtMs, 2000);
  assert.equal(last[1].remainingPercent, 76);

  const median = collapseSameXPoints(
    [
      { x: 10.1, y: 100, remainingPercent: 80, fetchedAtMs: 1000 },
      { x: 10.4, y: 220, remainingPercent: 40, fetchedAtMs: 2000 },
      { x: 10.8, y: 160, remainingPercent: 60, fetchedAtMs: 3000 }
    ],
    2,
    "median"
  );
  assert.equal(median.length, 1);
  assert.equal(median[0].remainingPercent, 60);
  assert.equal(median[0].y, 160);
  assert.equal(median[0].fetchedAtMs, 3000);
}

function verifyNearestSeriesPointChoosesClosestLine() {
  const samples = normalizeQuotaHistoryPayload(payload);
  const chart = buildChartSeries(samples, { x: 100, y: 50, width: 600, height: 300 });
  const nearSecondary = nearestSeriesPoint(chart.series, { x: 405, y: 68 }, 42);
  assert.equal(nearSecondary.seriesKey, "secondary");
  assert.equal(nearSecondary.remainingPercent, 94);

  const nearPrimary = nearestSeriesPoint(chart.series, { x: 405, y: 172 }, 42);
  assert.equal(nearPrimary.seriesKey, "primary");
  assert.equal(nearPrimary.remainingPercent, 60);

  const nearVelocity = nearestSeriesPoint(
    {
      longIdeal: chart.series.longIdeal,
      longVelocityRequired: chart.series.longVelocityRequired
    },
    { x: 405, y: 98 },
    42
  );
  assert.equal(nearVelocity.seriesKey, "longVelocityRequired");
  assert.equal(nearVelocity.remainingPercent, 84);
  assert.equal(nearVelocity.valueKind, "requiredRemainingPercent");

  const farAway = nearestSeriesPoint(chart.series, { x: 405, y: 330 }, 30);
  assert.equal(farAway, null);
}

verifyNormalizesHistorySamples();
verifyBuildsScaledSeries();
verifyLinePathUsesStraightSegments();
verifyBuildsIdealLineFromRawHistory();
verifyBuildsVelocityLineFromRawHistory();
verifyConnectsLinesAcrossMissingSamplesAndResetBoundaries();
verifyResetLinesDoNotUseFiveHourWindow();
verifyCollapsesSameXPoints();
verifyNearestSeriesPointChoosesClosestLine();
console.log("Verified quota history chart normalization, continuous straight-line rendering, 7d-only reset markers, scaling, and hover hit testing.");
