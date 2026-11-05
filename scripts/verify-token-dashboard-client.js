const assert = require("node:assert/strict");
const path = require("node:path");
const {
  executableCandidates,
  normalizeUsage,
  normalizeUsageRange,
  normalizeWidgetPayload
} = require("../src/main/token-dashboard-client");

function payload(usage = {}) {
  return {
    version: 1,
    generated_at: "2026-07-13T00:00:00.000Z",
    quota_status: { ignored_for_lamp: true },
    cycles: {
      five_hour: {
        remaining_percent: 82,
        used_percent: 18,
        reset_at: "2026-07-13T04:00:00.000Z",
        window_minutes: 300,
        observed_at: "2026-07-13T00:00:00.000Z",
        stale: false
      },
      seven_day: {
        remaining_percent: 70,
        used_percent: 30,
        reset_at: "2026-07-18T14:24:00.000Z",
        window_minutes: 10080,
        observed_at: "2026-07-13T00:00:00.000Z",
        stale: false
      }
    },
    usage: {
      range: "cycle_5h",
      label: "5h周期（未读到重置点，暂按5小时）",
      start: "2026-07-12T19:00:00.000Z",
      end: "2026-07-13T00:00:00.000Z",
      cost_base: 0.004321,
      cost_max: 0.004321,
      cost_complete: true,
      data_complete: true,
      ...usage
    }
  };
}

const widget = normalizeWidgetPayload(payload(), "cycle_5h");
assert.equal(widget.cycles.fiveHour.remainingPercent, 82);
assert.equal(widget.cycles.sevenDay.remainingPercent, 70);
assert.equal(widget.usage.label, "5h");
assert.equal(widget.usage.detailLabel, "5h");
assert.equal(widget.usage.displayValue, "≈$0.0043");
assert.equal(
  normalizeUsage({ range: "cycle_5h", cost_base: 1, cost_max: 3 }, "cycle_5h").displayValue,
  "≈$2.00"
);
assert.equal(Object.hasOwn(widget.cycles.fiveHour, "velocity"), false);
assert.equal(widget.quotaSignal.status, "behind");
assert.equal(
  normalizeWidgetPayload(payload({ cost_base: 999, cost_max: 1200 }), "cycle_5h").quotaSignal.status,
  widget.quotaSignal.status,
  "美元用量不得改变额度灯状态"
);

const rangeUsage = normalizeUsage(
  { range: "today", cost_base: 1.84, cost_max: 2.1, cost_complete: false, data_complete: false },
  "today"
);
assert.equal(rangeUsage.label, "今天");
assert.equal(rangeUsage.displayValue, "≈$1.97");
for (const range of ["cycle_7d", "last_3h", "week"]) {
  assert.equal(
    normalizeUsage({ range, cost_base: 10, cost_max: 14 }, range).displayValue,
    "≈$12.00",
    `${range} 应显示单个中位估值`
  );
}
assert.equal(normalizeUsageRange("not-a-range"), "cycle_5h");

const candidates = executableCandidates({
  appPath: path.resolve("D:/Codex/Codex-Led-Widget"),
  resourcesPath: path.resolve("D:/Package/resources"),
  env: { CODEX_TOKEN_DASHBOARD_EXE: "D:/Configured/Dashboard.exe" }
});
assert.equal(candidates[0], path.resolve("D:/Configured/Dashboard.exe"));
assert.equal(candidates[1], path.resolve("D:/Package/resources/backend/CodexTokenDashboard-Slim.exe"));
assert.ok(candidates.some((value) => value.endsWith(path.join("TOKEN", "output", "CodexTokenDashboard-Slim.exe"))));

console.log("Verified Token widget contract mapping, compact usage labels, adaptive USD precision, and executable discovery order.");
