const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { QuotaStore, HIDDEN_REFRESH_INTERVAL_MS } = require("../src/main/quota-store");

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

function quotaSnapshot({
  primaryRemaining,
  secondaryRemaining,
  fetchedAt,
  primaryResetsAt,
  secondaryResetsAt
}) {
  const snapshot = quota(primaryRemaining, fetchedAt);
  snapshot.primary = {
    ...snapshot.primary,
    usedPercent: 100 - primaryRemaining,
    remainingPercent: primaryRemaining,
    resetsAt: primaryResetsAt
  };
  snapshot.secondary = {
    ...snapshot.secondary,
    usedPercent: 100 - secondaryRemaining,
    remainingPercent: secondaryRemaining,
    resetsAt: secondaryResetsAt
  };
  snapshot.remainingPercent = primaryRemaining;
  snapshot.usedPercent = 100 - primaryRemaining;
  snapshot.resetsAt = primaryResetsAt;
  return snapshot;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localIsoDaysAgo(daysAgo, hour, minute = 0) {
  const date = new Date(Date.now() - daysAgo * DAY_MS);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function localDateKey(isoString) {
  const date = new Date(isoString);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
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
    assert.equal(second.quota.paceAdvice.longWindow.velocity.burnRatePercentPerHour, 0.2);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.rawBurnedPercent, 6);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.auxiliaryBurnedPercent, 6);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.smoothedBurnedPercent, 1.1);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.adjustedBurnedPercent, 1.1);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.shortToLongUsageRatio, 0.18);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.shortToLongUsageRatioConfidence, 0.08);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.observedShortToLongUsageRatio, 0.25);
    assert.equal(second.quota.paceAdvice.longWindow.velocity.recentRequiredRemainingPercent, 28.6);
    assert.ok(second.quota.paceAdvice.longWindow.velocity.requiredRemainingPercent < 70);
    assert.ok(second.quota.paceAdvice.longWindow.velocity.requiredRemainingPercent > 50);
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

async function verifyHistoryStateReturnsSamplesCopy() {
  await withTempDir(async (dir) => {
    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => quota(55),
      autoSchedule: false
    });

    await store.refreshNow("history-state");
    const historyState = store.getHistoryState();
    assert.equal(historyState.version, 1);
    assert.equal(historyState.samples.length, 1);
    assert.equal(historyState.samples[0].primary.remainingPercent, 55);
    assert.equal(Object.hasOwn(historyState.samples[0], "paceAdvice"), false);

    historyState.samples[0].primary.remainingPercent = 1;
    assert.equal(store.getHistoryState().samples[0].primary.remainingPercent, 55);
    store.destroy();
  });
}

async function verifyLongTermHistoryKeepsCoarseSamples() {
  await withTempDir(async (dir) => {
    const oldDenseSamples = [90, 86, 72, 83, 76, 88, 81, 79].map((remainingPercent, index) =>
      quota(remainingPercent, localIsoDaysAgo(45, 8 + index))
    );
    const recentSamples = [62, 61].map((remainingPercent, index) =>
      quota(remainingPercent, localIsoDaysAgo(1, 10 + index))
    );
    const expiredSample = quota(50, localIsoDaysAgo(200, 12));
    await fs.writeFile(
      path.join(dir, "quota-history.json"),
      `${JSON.stringify({ version: 1, samples: [expiredSample, ...oldDenseSamples, ...recentSamples] })}\n`,
      "utf8"
    );

    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => quota(55),
      autoSchedule: false
    });

    await store.loadHistory();
    const samples = store.getHistoryState().samples;
    const oldDayKey = localDateKey(oldDenseSamples[0].fetchedAt);
    const oldKept = samples.filter((sample) => localDateKey(sample.fetchedAt) === oldDayKey);

    assert.equal(samples.some((sample) => sample.fetchedAt === expiredSample.fetchedAt), false);
    assert.ok(oldKept.length > 0, "older quota history remains queryable");
    assert.ok(oldKept.length < oldDenseSamples.length, "older quota history is downsampled");
    assert.equal(oldKept[0].fetchedAt, oldDenseSamples[0].fetchedAt);
    assert.equal(oldKept[oldKept.length - 1].fetchedAt, oldDenseSamples[oldDenseSamples.length - 1].fetchedAt);
    for (const sample of recentSamples) {
      assert.equal(samples.some((entry) => entry.fetchedAt === sample.fetchedAt), true);
    }
    store.destroy();
  });
}

async function verifySingleUpwardJumpIsNotPublishedOrPersisted() {
  await withTempDir(async (dir) => {
    const stablePrimaryReset = "2026-07-10T06:41:28.000Z";
    const stableSecondaryReset = "2026-07-17T01:41:28.000Z";
    const snapshots = [
      quotaSnapshot({
        primaryRemaining: 47,
        secondaryRemaining: 92,
        fetchedAt: "2026-07-10T04:05:13.491Z",
        primaryResetsAt: stablePrimaryReset,
        secondaryResetsAt: stableSecondaryReset
      }),
      quotaSnapshot({
        primaryRemaining: 98,
        secondaryRemaining: 100,
        fetchedAt: "2026-07-10T04:06:16.842Z",
        primaryResetsAt: "2026-07-10T08:05:44.000Z",
        secondaryResetsAt: "2026-07-17T03:05:44.000Z"
      }),
      quotaSnapshot({
        primaryRemaining: 46,
        secondaryRemaining: 91,
        fetchedAt: "2026-07-10T04:07:18.567Z",
        primaryResetsAt: stablePrimaryReset,
        secondaryResetsAt: stableSecondaryReset
      })
    ];
    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => snapshots.shift(),
      autoSchedule: false
    });

    await store.refreshNow("stable-baseline");
    const heldState = await store.refreshNow("one-off-upward-jump");
    assert.equal(heldState.quota.primary.remainingPercent, 47);
    assert.equal(heldState.quota.secondary.remainingPercent, 92);
    assert.equal(heldState.refreshing, false);
    assert.equal(store.getHistoryState().samples.length, 1);

    const cachedAfterHeldRead = JSON.parse(
      await fs.readFile(path.join(dir, "quota-cache.json"), "utf8")
    );
    assert.equal(cachedAfterHeldRead.quota.primary.remainingPercent, 47);
    assert.equal(cachedAfterHeldRead.quota.secondary.remainingPercent, 92);

    const recoveredState = await store.refreshNow("stable-window-returned");
    assert.equal(recoveredState.quota.primary.remainingPercent, 46);
    assert.equal(recoveredState.quota.secondary.remainingPercent, 91);
    const history = store.getHistoryState().samples;
    assert.equal(history.length, 2);
    assert.equal(history.some((sample) => sample.primary.remainingPercent === 98), false);
    store.destroy();
  });
}

async function verifyConfirmedResetIsAcceptedOnThirdMatchingRead() {
  await withTempDir(async (dir) => {
    const resetPrimary = "2026-07-10T09:01:00.000Z";
    const resetSecondary = "2026-07-17T04:01:00.000Z";
    const snapshots = [
      quotaSnapshot({
        primaryRemaining: 5,
        secondaryRemaining: 20,
        fetchedAt: "2026-07-10T04:00:00.000Z",
        primaryResetsAt: "2026-07-10T06:00:00.000Z",
        secondaryResetsAt: "2026-07-17T01:00:00.000Z"
      }),
      quotaSnapshot({
        primaryRemaining: 100,
        secondaryRemaining: 100,
        fetchedAt: "2026-07-10T04:01:00.000Z",
        primaryResetsAt: resetPrimary,
        secondaryResetsAt: resetSecondary
      }),
      quotaSnapshot({
        primaryRemaining: 99,
        secondaryRemaining: 100,
        fetchedAt: "2026-07-10T04:02:00.000Z",
        primaryResetsAt: resetPrimary,
        secondaryResetsAt: resetSecondary
      }),
      quotaSnapshot({
        primaryRemaining: 98,
        secondaryRemaining: 100,
        fetchedAt: "2026-07-10T04:03:00.000Z",
        primaryResetsAt: resetPrimary,
        secondaryResetsAt: resetSecondary
      })
    ];
    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => snapshots.shift(),
      autoSchedule: false
    });

    await store.refreshNow("pre-reset");
    const firstResetRead = await store.refreshNow("reset-candidate");
    assert.equal(firstResetRead.quota.primary.remainingPercent, 5);

    const secondResetRead = await store.refreshNow("reset-confirmation-2");
    assert.equal(secondResetRead.quota.primary.remainingPercent, 5);

    const confirmedReset = await store.refreshNow("reset-confirmation-3");
    assert.equal(confirmedReset.quota.primary.remainingPercent, 98);
    assert.equal(confirmedReset.quota.secondary.remainingPercent, 100);
    assert.equal(store.getHistoryState().samples.length, 2);
    store.destroy();
  });
}

async function verifySmallResetDriftUsesFastRefresh() {
  await withTempDir(async (dir) => {
    const stablePrimaryReset = "2026-07-10T22:29:05.000Z";
    const stableSecondaryReset = "2026-07-17T17:29:05.000Z";
    const snapshots = [
      quotaSnapshot({
        primaryRemaining: 91,
        secondaryRemaining: 99,
        fetchedAt: "2026-07-10T19:05:05.000Z",
        primaryResetsAt: stablePrimaryReset,
        secondaryResetsAt: stableSecondaryReset
      }),
      quotaSnapshot({
        primaryRemaining: 99,
        secondaryRemaining: 100,
        fetchedAt: "2026-07-10T19:06:06.000Z",
        primaryResetsAt: "2026-07-10T22:32:32.000Z",
        secondaryResetsAt: "2026-07-17T17:32:32.000Z"
      }),
      quotaSnapshot({
        primaryRemaining: 90,
        secondaryRemaining: 99,
        fetchedAt: "2026-07-10T19:06:11.000Z",
        primaryResetsAt: stablePrimaryReset,
        secondaryResetsAt: stableSecondaryReset
      })
    ];
    const store = new QuotaStore({
      userDataPath: dir,
      readQuota: async () => snapshots.shift(),
      visibleRefreshIntervalMs: 60_000,
      driftRefreshIntervalMs: 5_000,
      autoSchedule: true
    });

    await store.refreshNow("stable-baseline");
    const heldState = await store.refreshNow("small-reset-drift");
    assert.equal(heldState.quota.primary.remainingPercent, 91);
    assert.equal(heldState.quota.secondary.remainingPercent, 99);
    const fastDelayMs = Date.parse(heldState.nextRefreshAt) - Date.now();
    assert.ok(fastDelayMs >= 4_000 && fastDelayMs <= 5_500);

    const recoveredState = await store.refreshNow("stable-window-returned");
    assert.equal(recoveredState.quota.primary.remainingPercent, 90);
    const normalDelayMs = Date.parse(recoveredState.nextRefreshAt) - Date.now();
    assert.ok(normalDelayMs >= 59_000 && normalDelayMs <= 60_500);
    store.destroy();
  });
}

function verifyHiddenRefreshIntervalDefault() {
  assert.equal(HIDDEN_REFRESH_INTERVAL_MS, 5 * 60 * 1000);
}

(async () => {
  await verifyCacheLoad();
  await verifyRefreshCoalescing();
  await verifyFailurePreservesQuota();
  await verifyHistoryBackedVelocityAdvice();
  await verifyVisibleRefreshIntervalCanChange();
  await verifyHistoryStateReturnsSamplesCopy();
  await verifyLongTermHistoryKeepsCoarseSamples();
  await verifySingleUpwardJumpIsNotPublishedOrPersisted();
  await verifyConfirmedResetIsAcceptedOnThirdMatchingRead();
  await verifySmallResetDriftUsesFastRefresh();
  verifyHiddenRefreshIntervalDefault();
  console.log("Verified quota store cache, refresh coalescing, stale-data errors, history-backed velocity advice, and refresh interval settings.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
