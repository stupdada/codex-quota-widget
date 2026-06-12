const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { QuotaStore } = require("../src/main/quota-store");

function quota(remainingPercent, fetchedAt = "2026-06-10T00:00:00.000Z") {
  return {
    limitId: "codex",
    limitName: "Codex",
    planType: "test",
    reachedType: null,
    credits: null,
    primary: {
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      windowDurationMins: 300,
      resetsAt: "2026-06-10T05:00:00.000Z"
    },
    secondary: {
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      windowDurationMins: 10080,
      resetsAt: "2026-06-17T00:00:00.000Z"
    },
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    resetsAt: "2026-06-10T05:00:00.000Z",
    fetchedAt,
    paceAdvice: {
      longWindow: null,
      shortWindow: null,
      overall: { status: "unknown", severity: "muted", reasonCode: "test", source: "test" },
      thresholds: { paceDelta: 15, criticalRemainingPercent: 5 }
    }
  };
}

async function withTempDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-store-"));
  try {
    await callback(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function verifyCacheLoad() {
  await withTempDir(async (dir) => {
    const cachedQuota = quota(42);
    await fs.writeFile(
      path.join(dir, "quota-cache.json"),
      `${JSON.stringify({ version: 1, savedAt: "2026-06-10T00:01:00.000Z", quota: cachedQuota })}\n`,
      "utf8"
    );

    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => quota(10),
      autoSchedule: false
    });
    await store.loadCache();
    const state = store.getState();
    assert.equal(state.status, "ready");
    assert.equal(state.fromCache, true);
    assert.equal(state.quota.remainingPercent, 42);
    store.destroy();
  });
}

async function verifyRefreshCoalescing() {
  await withTempDir(async (dir) => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => {
        calls += 1;
        await gate;
        return quota(77);
      },
      autoSchedule: false
    });

    const first = store.refreshNow("first");
    const second = store.refreshNow("second");
    assert.equal(calls, 1);
    release();
    const states = await Promise.all([first, second]);
    assert.equal(states[0].quota.remainingPercent, 77);
    assert.equal(states[1].quota.remainingPercent, 77);
    assert.equal(store.getState().status, "ready");
    assert.equal(calls, 1);
    await fs.access(path.join(dir, "quota-cache.json"));
    store.destroy();
  });
}

async function verifyFailurePreservesQuota() {
  await withTempDir(async (dir) => {
    const cachedQuota = quota(64);
    await fs.writeFile(
      path.join(dir, "quota-cache.json"),
      `${JSON.stringify({ version: 1, savedAt: "2026-06-10T00:01:00.000Z", quota: cachedQuota })}\n`,
      "utf8"
    );

    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => {
        throw new Error("network unavailable");
      },
      autoSchedule: false
    });
    await store.loadCache();
    const state = await store.refreshNow("failure-case");
    assert.equal(state.status, "error");
    assert.equal(state.quota.remainingPercent, 64);
    assert.match(state.error.message, /network unavailable/);
    store.destroy();
  });
}

async function verifyHistoryBackedVelocityAdvice() {
  await withTempDir(async (dir) => {
    const samples = [quota(70, "2026-06-10T00:00:00.000Z"), quota(64, "2026-06-10T06:00:00.000Z")];
    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => samples.shift(),
      autoSchedule: false
    });

    const first = await store.refreshNow("first");
    assert.equal(first.quota.paceAdvice.longWindow.velocity.source, "ideal");
    assert.equal(first.quota.paceAdvice.longWindow.velocity.sampleWindowMins, 0);

    const second = await store.refreshNow("second");
    assert.equal(second.quota.paceAdvice.longWindow.velocity.sampleWindowMins, 360);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.burnRatePercentPerHour, 1);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.recentRequiredRemainingPercent, 100);
    assert.ok(second.quota.paceAdvice.longWindow.velocity.requiredRemainingPercent < 100);
    assert.ok(second.quota.paceAdvice.longWindow.velocity.requiredRemainingPercent > 96);
    await fs.access(path.join(dir, "quota-history.json"));
    store.destroy();
  });
}

async function verifyVisibleRefreshIntervalCanChange() {
  await withTempDir(async (dir) => {
    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => quota(80),
      visibleRefreshIntervalMs: 10_000,
      autoSchedule: false
    });

    store.setVisibleRefreshIntervalMs(60_000);
    assert.equal(store.visibleRefreshIntervalMs, 60_000);
    assert.throws(() => store.setVisibleRefreshIntervalMs(0), /positive number/);
    store.destroy();
  });
}

(async () => {
  await verifyCacheLoad();
  await verifyRefreshCoalescing();
  await verifyFailurePreservesQuota();
  await verifyHistoryBackedVelocityAdvice();
  await verifyVisibleRefreshIntervalCanChange();
  console.log("Verified quota store cache, refresh coalescing, stale-data errors, history-backed velocity advice, and refresh interval settings.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
