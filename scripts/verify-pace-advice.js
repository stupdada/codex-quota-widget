const assert = require("node:assert/strict");
const { buildPaceAdvice, urgentPaceDeltaThreshold } = require("../src/main/pace-advice");
const { normalizeSnapshot } = require("../src/main/quota-service");

const now = new Date("2026-06-09T00:00:00.000Z");
const sevenDaysMins = 7 * 24 * 60;
const fiveHoursMins = 5 * 60;

function resetAt(durationMins, remainingTimePercent) {
  return new Date(now.getTime() + durationMins * 60 * 1000 * (remainingTimePercent / 100)).toISOString();
}

function makeSnapshot(weeklyRemainingPercent, weeklyRemainingTimePercent = 50, shortRemainingPercent = 50) {
  return {
    primary: {
      remainingPercent: shortRemainingPercent,
      windowDurationMins: fiveHoursMins,
      resetsAt: resetAt(fiveHoursMins, 50)
    },
    secondary: {
      remainingPercent: weeklyRemainingPercent,
      windowDurationMins: sevenDaysMins,
      resetsAt: resetAt(sevenDaysMins, weeklyRemainingTimePercent)
    }
  };
}

function historySample(snapshot, hoursAgo, weeklyRemainingPercent, shortRemainingPercent = snapshot.primary.remainingPercent) {
  return {
    fetchedAt: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
    primary: {
      remainingPercent: shortRemainingPercent,
      windowDurationMins: snapshot.primary.windowDurationMins,
      resetsAt: snapshot.primary.resetsAt
    },
    secondary: {
      remainingPercent: weeklyRemainingPercent,
      windowDurationMins: snapshot.secondary.windowDurationMins,
      resetsAt: snapshot.secondary.resetsAt
    }
  };
}

const cases = [
  {
    name: "7d time 50%, quota 80% and 5h normal => urgent overall",
    snapshot: makeSnapshot(80),
    expected: "accelerate",
    expectedOverall: "urgent",
    expectedOverallReason: "urgentAhead",
    expectedOverallSource: "combined"
  },
  {
    name: "7d time 50%, quota 50% => normal",
    snapshot: makeSnapshot(50),
    expected: "normal"
  },
  {
    name: "7d time 50%, quota 20% => slow",
    snapshot: makeSnapshot(20),
    expected: "slow",
    expectedOverall: "slow",
    expectedOverallReason: "bothReferencesBehind",
    expectedOverallSource: "combined"
  },
  {
    name: "7d quota 5% => critical",
    snapshot: makeSnapshot(5),
    expected: "critical"
  },
  {
    name: "7d quota below 5% => critical",
    snapshot: makeSnapshot(4),
    expected: "critical"
  },
  {
    name: "7d delta +15 boundary and 5h normal => accelerate overall",
    snapshot: makeSnapshot(65),
    expected: "accelerate"
  },
  {
    name: "7d delta -15 boundary => slow",
    snapshot: makeSnapshot(35),
    expected: "slow",
    expectedOverall: "slow",
    expectedOverallReason: "bothReferencesBehind",
    expectedOverallSource: "combined"
  },
  {
    name: "5h conflict stays auxiliary when 7d is normal",
    snapshot: makeSnapshot(50, 50, 95),
    expected: "normal",
    expectedShort: "accelerate"
  },
  {
    name: "7d ahead but 5h behind => recent fast overall",
    snapshot: makeSnapshot(80, 50, 20),
    expected: "accelerate",
    expectedShort: "slow",
    expectedOverall: "recentFast",
    expectedOverallReason: "shortWindowTight",
    expectedOverallSource: "short"
  },
  {
    name: "7d ahead but 5h normal reaches dynamic threshold => urgent overall",
    snapshot: makeSnapshot(80, 50, 50),
    expected: "accelerate",
    expectedShort: "normal",
    expectedOverall: "urgent",
    expectedOverallReason: "urgentAhead",
    expectedOverallSource: "combined"
  },
  {
    name: "7d ahead and 5h ahead reaches dynamic threshold => urgent overall",
    snapshot: makeSnapshot(80, 50, 80),
    expected: "accelerate",
    expectedShort: "accelerate",
    expectedOverall: "urgent",
    expectedOverallReason: "urgentAhead",
    expectedOverallSource: "combined"
  },
  {
    name: "7d delta +35 boundary and 5h normal => urgent overall",
    snapshot: makeSnapshot(85, 50, 50),
    expected: "accelerate",
    expectedShort: "normal",
    expectedOverall: "urgent",
    expectedOverallReason: "urgentAhead",
    expectedOverallSource: "combined"
  },
  {
    name: "7d urgent delta but 5h behind => recent fast overall",
    snapshot: makeSnapshot(90, 50, 20),
    expected: "accelerate",
    expectedShort: "slow",
    expectedOverall: "recentFast",
    expectedOverallReason: "shortWindowTight",
    expectedOverallSource: "short"
  },
  {
    name: "7d behind and 5h behind => slow overall",
    snapshot: makeSnapshot(20, 50, 20),
    expected: "slow",
    expectedShort: "slow",
    expectedOverall: "slow",
    expectedOverallReason: "bothWindowsBehind",
    expectedOverallSource: "combined"
  },
  {
    name: "7d normal but 5h critical => critical overall",
    snapshot: makeSnapshot(50, 50, 5),
    expected: "normal",
    expectedShort: "critical",
    expectedOverall: "critical",
    expectedOverallReason: "shortWindowCritical",
    expectedOverallSource: "short"
  },
  {
    name: "7d time 20%, quota 35% reaches lower dynamic threshold => urgent overall",
    snapshot: makeSnapshot(35, 20, 50),
    expected: "accelerate",
    expectedShort: "normal",
    expectedOverall: "urgent",
    expectedOverallReason: "urgentAhead",
    expectedOverallSource: "combined"
  },
  {
    name: "7d time 20%, quota 34% misses lower dynamic threshold => normal overall",
    snapshot: makeSnapshot(34, 20, 50),
    expected: "normal",
    expectedShort: "normal",
    expectedOverall: "normal"
  },
  {
    name: "7d time 0%, quota 8% reaches minimum dynamic threshold => urgent overall",
    snapshot: makeSnapshot(8, 0, 50),
    expected: "normal",
    expectedShort: "normal",
    expectedOverall: "urgent",
    expectedOverallReason: "urgentAhead",
    expectedOverallSource: "combined"
  },
  {
    name: "critical 7d still reports positive delta when ideal reaches zero",
    snapshot: makeSnapshot(5, 0, 50),
    expected: "critical",
    expectedOverall: "critical",
    expectedLongIdeal: 0,
    expectedLongDelta: 5
  }
];

for (const testCase of cases) {
  const advice = buildPaceAdvice(testCase.snapshot, now);
  assert.equal(advice.longWindow.status, testCase.expected, testCase.name);
  assert.equal(advice.overall.status, testCase.expectedOverall ?? testCase.expected, `${testCase.name} overall`);
  if (testCase.expectedLongIdeal !== undefined) {
    assert.equal(advice.longWindow.idealRemainingPercent, testCase.expectedLongIdeal, `${testCase.name} ideal`);
  }
  if (testCase.expectedLongDelta !== undefined) {
    assert.equal(advice.longWindow.paceDelta, testCase.expectedLongDelta, `${testCase.name} delta`);
  }
  if (testCase.expectedShort) {
    assert.equal(advice.shortWindow.status, testCase.expectedShort, `${testCase.name} short`);
  }
  if (testCase.expectedOverallReason) {
    assert.equal(advice.overall.reasonCode, testCase.expectedOverallReason, `${testCase.name} overall reason`);
  }
  if (testCase.expectedOverallSource) {
    assert.equal(advice.overall.source, testCase.expectedOverallSource, `${testCase.name} overall source`);
  }
}

assert.equal(urgentPaceDeltaThreshold({ idealRemainingPercent: 80 }), 35, "urgent threshold clamps high");
assert.equal(urgentPaceDeltaThreshold({ idealRemainingPercent: 50 }), 30, "urgent threshold at midpoint");
assert.equal(urgentPaceDeltaThreshold({ idealRemainingPercent: 20 }), 15, "urgent threshold near reset");
assert.equal(urgentPaceDeltaThreshold({ idealRemainingPercent: 0 }), 8, "urgent threshold clamps low");
assert.equal(urgentPaceDeltaThreshold({ idealRemainingPercent: null }), null, "urgent threshold requires time left");

{
  const snapshot = makeSnapshot(50, 50, 50);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 6, 100, 100)]);
  assert.equal(advice.longWindow.velocity.recentRequiredRemainingPercent, 100, "5h-supported dynamic required clamps high");
  assert.ok(
    advice.longWindow.velocity.requiredRemainingPercent > 60 && advice.longWindow.velocity.requiredRemainingPercent < 100,
    "low-confidence 7d dynamic line blends high recent burn with ideal pace"
  );
  assert.equal(advice.longWindow.velocity.sampleWindowMins, 360, "dynamic sample window is reported");
  assert.equal(advice.overall.status, "recentFast", "dynamic pressure overrides surplus ideal pace");
  assert.equal(advice.overall.reasonCode, "dynamicPaceTight", "dynamic pressure reason is explicit");
}

{
  const snapshot = makeSnapshot(20, 50, 50);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 6, 20)]);
  assert.equal(advice.longWindow.velocity.recentRequiredRemainingPercent, 0, "no recent burn creates a zero raw recent line");
  assert.equal(advice.overall.status, "coolingDown", "behind ideal but safe recent speed means keep slowing");
}

{
  const snapshot = makeSnapshot(20, 50, 50);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 6, 100, 100)]);
  assert.equal(advice.overall.status, "slow", "behind both ideal and dynamic references means slow down");
  assert.equal(advice.overall.reasonCode, "bothReferencesBehind", "both-reference reason is explicit");
}

{
  const snapshot = makeSnapshot(60, 50, 50);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 0.05, 80)]);
  assert.equal(advice.longWindow.velocity.sampleWindowMins, 0, "too-short recent history does not become recent speed");
  assert.equal(advice.longWindow.velocity.recentConfidence, 0, "too-short recent history has zero recent confidence");
  assert.equal(advice.overall.status, "normal", "insufficient recent sample stays close to ideal pace");
}

{
  const snapshot = makeSnapshot(98, 98, 50);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 0.6, 99)]);
  assert.equal(advice.longWindow.velocity.recentRequiredRemainingPercent, 0, "unsupported raw 7d tick is not used as fractional speed");
  assert.equal(advice.longWindow.velocity.rawBurnedPercent, 1, "raw 7d tick remains visible for diagnostics");
  assert.equal(advice.longWindow.velocity.smoothedBurnedPercent, 0, "5h-assisted fractional 7d burn suppresses unsupported tick");
  assert.ok(advice.longWindow.velocity.requiredRemainingPercent < 99, "low-confidence 7d sample is damped near ideal");
  assert.equal(advice.overall.status, "normal", "tiny early 7d burn does not become a false slowdown");
}

{
  const snapshot = makeSnapshot(80, 50, 55);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 0.5, 80, 100)]);
  assert.equal(advice.shortWindow.velocity.recentRequiredRemainingPercent, 100, "5h fast burn stays sensitive");
  assert.equal(advice.overall.status, "recentFast", "5h pressure still drives recent-fast advice");
  assert.equal(advice.overall.reasonCode, "shortWindowTight", "5h pressure source remains explicit");
}

{
  const snapshot = makeSnapshot(95, 5, 80);
  const unsupported = buildPaceAdvice(snapshot, now, [historySample(snapshot, 0.5, 96, 80)]);
  assert.ok(
    unsupported.longWindow.velocity.recentRequiredRemainingPercent < 10,
    "unsupported 7d integer tick is damped by 5h evidence"
  );
  assert.equal(unsupported.longWindow.velocity.auxiliaryBurnedPercent, 0, "5h support is reported");

  const supported = buildPaceAdvice(snapshot, now, [historySample(snapshot, 0.5, 96, 86)]);
  assert.ok(
    supported.longWindow.velocity.recentRequiredRemainingPercent > 15,
    "5h-supported 7d tick uses fractional 5h-derived speed"
  );
  assert.equal(supported.longWindow.velocity.rawBurnedPercent, 1, "raw tick is reported separately");
  assert.equal(supported.longWindow.velocity.smoothedBurnedPercent, 1, "fractional 7d burn is derived from 5h usage");
  assert.equal(supported.longWindow.velocity.shortToLongUsageRatio, 0.17, "5h to 7d ratio is exposed for diagnostics");
}

{
  const snapshot = makeSnapshot(91, 89.3, 78);
  const advice = buildPaceAdvice(snapshot, now, [historySample(snapshot, 0.5, 92, 78)]);
  assert.equal(advice.longWindow.velocity.rawBurnedPercent, 1, "official 7d integer tick is retained");
  assert.equal(advice.longWindow.velocity.smoothedBurnedPercent, 0, "7d integer tick without 5h support is suppressed");
  assert.equal(advice.longWindow.velocity.recentRequiredRemainingPercent, 0, "blue 7d line no longer jumps on unsupported integer tick");
  assert.ok(advice.longWindow.velocity.requiredRemainingPercent < 90, "combined velocity stays below the ideal line after an unsupported tick");
}

{
  const snapshot = makeSnapshot(60, 50, 50);
  const history = [
    historySample(snapshot, 24, 72, 100),
    historySample(snapshot, 12, 66, 75)
  ];
  const advice = buildPaceAdvice(snapshot, now, history);
  assert.equal(advice.longWindow.velocity.observedShortToLongUsageRatio, 0.24, "observed ratio is reported");
  assert.equal(advice.longWindow.velocity.shortToLongUsageRatioConfidence, 0.5, "ratio confidence grows with evidence");
  assert.equal(advice.longWindow.velocity.shortToLongUsageRatio, 0.21, "ratio blends prior with local history");
}

{
  const snapshot = makeSnapshot(80, 50, 80);
  const oldReset = "2026-06-03T00:00:00.000Z";
  const history = [
    {
      fetchedAt: "2026-06-02T00:00:00.000Z",
      primary: {
        remainingPercent: 100,
        windowDurationMins: snapshot.primary.windowDurationMins,
        resetsAt: "2026-06-02T05:00:00.000Z"
      },
      secondary: {
        remainingPercent: 100,
        windowDurationMins: snapshot.secondary.windowDurationMins,
        resetsAt: oldReset
      }
    },
    {
      fetchedAt: "2026-06-02T06:00:00.000Z",
      primary: {
        remainingPercent: 50,
        windowDurationMins: snapshot.primary.windowDurationMins,
        resetsAt: "2026-06-02T05:00:00.000Z"
      },
      secondary: {
        remainingPercent: 70,
        windowDurationMins: snapshot.secondary.windowDurationMins,
        resetsAt: oldReset
      }
    }
  ];
  const advice = buildPaceAdvice(snapshot, now, history);
  assert.equal(advice.longWindow.velocity.recentRequiredRemainingPercent, null, "cross-reset history is not direct recent speed");
  assert.ok(advice.longWindow.velocity.learnedRequiredRemainingPercent > 50, "cross-reset behavior feeds learned profile");
  assert.equal(advice.longWindow.velocity.source, "learned", "learned profile can drive early-cycle dynamic line");
}

const normalized = normalizeSnapshot({
  limitId: "codex",
  primary: {
    usedPercent: 25,
    windowDurationMins: fiveHoursMins,
    resetsAt: Math.floor(now.getTime() / 1000)
  }
});

assert.equal(normalized.remainingPercent, 75, "normalizes remaining percent from usedPercent");
assert.equal(normalized.primary.resetsAt, now.toISOString(), "normalizes reset timestamp seconds");
assert.throws(
  () => normalizeSnapshot({}),
  /does not include a usable quota window/,
  "rejects snapshots without quota windows"
);
assert.throws(
  () => normalizeSnapshot({ primary: { windowDurationMins: fiveHoursMins } }),
  /missing a numeric usedPercent/,
  "rejects quota windows without usedPercent"
);
assert.throws(
  () => normalizeSnapshot({ primary: { usedPercent: 25, resetsAt: "not-a-time" } }),
  /invalid reset timestamp/,
  "rejects invalid reset timestamps"
);

console.log(`Verified ${cases.length} pace advice cases, 10 dynamic pace checks, and 5 quota normalization checks.`);
