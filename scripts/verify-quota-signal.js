const assert = require("node:assert/strict");
const { deriveQuotaSignal, idealRemainingPercent, normalizeCycle } = require("../src/main/quota-signal");

const observedAt = "2026-07-13T00:00:00.000Z";
const fiveHour = normalizeCycle(
  {
    remaining_percent: 40,
    used_percent: 60,
    reset_at: "2026-07-13T02:30:00.000Z",
    window_minutes: 300,
    observed_at: observedAt,
    stale: false
  },
  observedAt
);
assert.equal(idealRemainingPercent(fiveHour), 50);
assert.equal(fiveHour.delta, -10);
assert.equal(Object.hasOwn(fiveHour, "velocity"), false);

const sevenDay = normalizeCycle(
  {
    remaining_percent: 80,
    reset_at: "2026-07-18T14:24:00.000Z",
    window_minutes: 10080,
    observed_at: observedAt
  },
  observedAt
);
assert.equal(Math.round(sevenDay.idealRemainingPercent), 80);
assert.equal(deriveQuotaSignal({ fiveHour, sevenDay }).status, "behind");

const critical = { ...fiveHour, remainingPercent: 5, delta: 0 };
const criticalSignal = deriveQuotaSignal({ fiveHour: critical, sevenDay });
assert.equal(criticalSignal.status, "critical");
assert.equal(criticalSignal.animation, "blink");

const staleSignal = deriveQuotaSignal({ fiveHour: { ...fiveHour, delta: 0, stale: true }, sevenDay });
assert.equal(staleSignal.status, "stale");
assert.equal(staleSignal.animation, "breathe");

assert.equal(deriveQuotaSignal({ fiveHour: null, sevenDay }).status, "healthy");
assert.equal(
  deriveQuotaSignal({ fiveHour, sevenDay }, { connectionUnavailable: true }).status,
  "stale"
);

console.log("Verified deterministic quota ideal lines, deltas, and quota-only signal states.");
