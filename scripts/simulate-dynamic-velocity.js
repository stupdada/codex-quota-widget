const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPaceAdvice, selectWindowKeys } = require("../src/main/pace-advice");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LEGACY_WINDOWS_BY_ROLE = {
  long: [6 * 60, 12 * 60, 24 * 60],
  short: [45, 90, 180]
};
const LEGACY_MIN_ELAPSED_MINS = 6;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function widgetDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "codex-quota-widget");
}

function summarizeWindow(window) {
  if (!window) return null;
  return {
    status: window.status,
    remainingPercent: window.remainingPercent,
    idealRemainingPercent: window.idealRemainingPercent,
    paceDelta: window.paceDelta,
    velocity: window.velocity
      ? {
          requiredRemainingPercent: window.velocity.requiredRemainingPercent,
          paceDelta: window.velocity.paceDelta,
          recentRequiredRemainingPercent: window.velocity.recentRequiredRemainingPercent,
          learnedRequiredRemainingPercent: window.velocity.learnedRequiredRemainingPercent,
          rawBurnedPercent: window.velocity.rawBurnedPercent,
          auxiliaryBurnedPercent: window.velocity.auxiliaryBurnedPercent,
          smoothedBurnedPercent: window.velocity.smoothedBurnedPercent,
          adjustedBurnedPercent: window.velocity.adjustedBurnedPercent,
          shortToLongUsageRatio: window.velocity.shortToLongUsageRatio,
          shortToLongUsageRatioConfidence: window.velocity.shortToLongUsageRatioConfidence,
          observedShortToLongUsageRatio: window.velocity.observedShortToLongUsageRatio,
          sampleWindowMins: window.velocity.sampleWindowMins,
          confidence: window.velocity.confidence,
          recentConfidence: window.velocity.recentConfidence,
          learnedConfidence: window.velocity.learnedConfidence,
          source: window.velocity.source
        }
      : null
  };
}

function legacyVelocity(snapshot, history, key, role, nowMs) {
  const current = Number(snapshot?.[key]?.remainingPercent);
  const resetsAt = snapshot?.[key]?.resetsAt || null;
  const resetsAtMs = Date.parse(resetsAt || "");
  if (!Number.isFinite(current) || !Number.isFinite(resetsAtMs)) return null;

  const samples = history
    .map((sample) => {
      const window = sample?.[key];
      return {
        fetchedAtMs: Date.parse(sample?.fetchedAt || ""),
        remainingPercent: Number(window?.remainingPercent),
        resetsAt: window?.resetsAt || null
      };
    })
    .filter(
      (sample) =>
        Number.isFinite(sample.fetchedAtMs) &&
        sample.fetchedAtMs < nowMs &&
        Number.isFinite(sample.remainingPercent) &&
        sample.resetsAt === resetsAt
    )
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);

  for (const windowMins of LEGACY_WINDOWS_BY_ROLE[role] || LEGACY_WINDOWS_BY_ROLE.short) {
    const startSample = samples.find((sample) => {
      const elapsedMs = nowMs - sample.fetchedAtMs;
      return elapsedMs >= LEGACY_MIN_ELAPSED_MINS * MINUTE_MS && elapsedMs <= windowMins * MINUTE_MS;
    });
    if (!startSample) continue;

    const elapsedHours = (nowMs - startSample.fetchedAtMs) / HOUR_MS;
    const burnedPercent = Math.max(0, startSample.remainingPercent - current);
    const burnRatePercentPerHour = elapsedHours > 0 ? burnedPercent / elapsedHours : 0;
    const hoursUntilReset = Math.max(0, resetsAtMs - nowMs) / HOUR_MS;
    const requiredRemainingPercent = Math.max(0, Math.min(100, burnRatePercentPerHour * hoursUntilReset));
    return {
      requiredRemainingPercent: Math.round(requiredRemainingPercent * 10) / 10,
      paceDelta: Math.round((current - requiredRemainingPercent) * 10) / 10,
      burnRatePercentPerHour: Math.round(burnRatePercentPerHour * 10) / 10,
      sampleWindowMins: Math.round((nowMs - startSample.fetchedAtMs) / MINUTE_MS)
    };
  }

  return null;
}

function main() {
  const dir = widgetDataDir();
  const cachePath = path.join(dir, "quota-cache.json");
  const historyPath = path.join(dir, "quota-history.json");
  const cache = readJson(cachePath);
  const historyPayload = readJson(historyPath);
  const history = Array.isArray(historyPayload.samples) ? historyPayload.samples : [];
  const quota = cache.quota;
  const now = quota?.fetchedAt || cache.savedAt || new Date().toISOString();
  const nowMs = Date.parse(now);
  const keys = selectWindowKeys(quota);
  const advice = buildPaceAdvice(quota, now, history);
  const fetchedTimes = history
    .map((sample) => Date.parse(sample.fetchedAt || ""))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const summary = {
    dataDir: dir,
    historySamples: history.length,
    oldestSample: fetchedTimes.length ? new Date(fetchedTimes[0]).toISOString() : null,
    newestSample: fetchedTimes.length ? new Date(fetchedTimes[fetchedTimes.length - 1]).toISOString() : null,
    simulatedAt: new Date(nowMs).toISOString(),
    overall: advice.overall,
    long: {
      key: keys.long,
      current: summarizeWindow(advice.longWindow),
      legacyRaw: keys.long ? legacyVelocity(quota, history, keys.long, "long", nowMs) : null
    },
    short: {
      key: keys.short,
      current: summarizeWindow(advice.shortWindow),
      legacyRaw: keys.short ? legacyVelocity(quota, history, keys.short, "short", nowMs) : null
    }
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
