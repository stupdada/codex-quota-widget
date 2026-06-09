const assert = require("node:assert/strict");
const { buildPaceAdvice } = require("../src/main/pace-advice");
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
    name: "7d time 50%, quota 80% => accelerate",
    snapshot: makeSnapshot(80),
    expected: "accelerate"
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
    name: "7d delta +15 boundary => accelerate",
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
  }
];

for (const testCase of cases) {
  const advice = buildPaceAdvice(testCase.snapshot, now);
  assert.equal(advice.longWindow.status, testCase.expected, testCase.name);
  assert.equal(advice.overall.status, testCase.expected, `${testCase.name} overall`);
  if (testCase.expectedShort) {
    assert.equal(advice.shortWindow.status, testCase.expectedShort, `${testCase.name} short`);
  }
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

console.log(`Verified ${cases.length} pace advice cases and 5 quota normalization checks.`);
