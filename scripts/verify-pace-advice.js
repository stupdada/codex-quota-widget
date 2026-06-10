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
    expected: "slow"
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
    expected: "slow"
  },
  {
    name: "5h conflict stays auxiliary when 7d is normal",
    snapshot: makeSnapshot(50, 50, 95),
    expected: "normal",
    expectedShort: "accelerate"
  },
  {
    name: "7d ahead but 5h behind => slow overall",
    snapshot: makeSnapshot(80, 50, 20),
    expected: "accelerate",
    expectedShort: "slow",
    expectedOverall: "slow",
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
    name: "7d urgent delta but 5h behind => slow overall",
    snapshot: makeSnapshot(90, 50, 20),
    expected: "accelerate",
    expectedShort: "slow",
    expectedOverall: "slow",
    expectedOverallReason: "shortWindowTight",
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
  }
];

for (const testCase of cases) {
  const advice = buildPaceAdvice(testCase.snapshot, now);
  assert.equal(advice.longWindow.status, testCase.expected, testCase.name);
  assert.equal(advice.overall.status, testCase.expectedOverall ?? testCase.expected, `${testCase.name} overall`);
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

console.log(`Verified ${cases.length} pace advice cases and 5 quota normalization checks.`);
