const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { QuotaStore } = require("../src/main/quota-store");

function quota(remainingPercent) {
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
    fetchedAt: "2026-06-10T00:00:00.000Z",
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

(async () => {
  await verifyCacheLoad();
  await verifyRefreshCoalescing();
  await verifyFailurePreservesQuota();
  console.log("Verified quota store cache, refresh coalescing, and stale-data error handling.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
