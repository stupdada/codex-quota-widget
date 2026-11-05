const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { getQuota } = require("./quota-service");
const { buildPaceAdvice } = require("./pace-advice");

const CACHE_FILE_NAME = "quota-cache.json";
const HISTORY_FILE_NAME = "quota-history.json";
const CACHE_VERSION = 1;
const HISTORY_VERSION = 1;
const HISTORY_FINE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 4096;
const HISTORY_COARSE_MAX_SAMPLES_PER_DAY = 6;
const VISIBLE_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const HIDDEN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const ERROR_RETRY_BASE_MS = 60 * 1000;
const ERROR_RETRY_MAX_MS = 5 * 60 * 1000;
const QUOTA_DRIFT_REMAINING_THRESHOLD = 3;
const QUOTA_DRIFT_RESET_TOLERANCE_MS = 30 * 1000;
const QUOTA_DRIFT_CONFIRMATION_READS = 3;
const QUOTA_DRIFT_REFRESH_INTERVAL_MS = 5 * 1000;

class QuotaStore extends EventEmitter {
  constructor({
    userDataPath,
    readQuota = getQuota,
    visibleRefreshIntervalMs = VISIBLE_REFRESH_INTERVAL_MS,
    hiddenRefreshIntervalMs = HIDDEN_REFRESH_INTERVAL_MS,
    driftRefreshIntervalMs = QUOTA_DRIFT_REFRESH_INTERVAL_MS,
    errorRetryBaseMs = ERROR_RETRY_BASE_MS,
    errorRetryMaxMs = ERROR_RETRY_MAX_MS,
    autoSchedule = true
  }) {
    super();
    if (!userDataPath) {
      throw new Error("QuotaStore requires a userDataPath.");
    }

    this.cachePath = path.join(userDataPath, CACHE_FILE_NAME);
    this.historyPath = path.join(userDataPath, HISTORY_FILE_NAME);
    this.readQuota = readQuota;
    this.visibleRefreshIntervalMs = visibleRefreshIntervalMs;
    this.hiddenRefreshIntervalMs = hiddenRefreshIntervalMs;
    this.driftRefreshIntervalMs = driftRefreshIntervalMs;
    this.errorRetryBaseMs = errorRetryBaseMs;
    this.errorRetryMaxMs = errorRetryMaxMs;
    this.autoSchedule = autoSchedule;
    this.windowVisible = true;
    this.failureCount = 0;
    this.history = [];
    this.pendingQuota = null;
    this.inFlight = null;
    this.timer = null;
    this.state = {
      status: "loading",
      quota: null,
      error: null,
      fromCache: false,
      refreshing: false,
      lastUpdatedAt: null,
      nextRefreshAt: null
    };
  }

  async loadCache() {
    await this.loadHistory();
    try {
      const cache = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
      if (cache?.version === CACHE_VERSION && cache.quota) {
        this.recordHistory(cache.quota);
        const quota = this.withCurrentPaceAdvice(cache.quota, cache.quota.fetchedAt || cache.savedAt);
        this.state = {
          ...this.state,
          status: "ready",
          quota,
          error: null,
          fromCache: true,
          lastUpdatedAt: cache.savedAt
        };
        this.emitState();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.state = {
          ...this.state,
          error: serializeError(error)
        };
      }
    }
    return this.getState();
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  getHistoryState() {
    return {
      version: HISTORY_VERSION,
      samples: JSON.parse(JSON.stringify(this.history))
    };
  }

  setWindowVisible(value) {
    this.windowVisible = Boolean(value);
    this.scheduleNextRefresh();
    return this.getState();
  }

  setVisibleRefreshIntervalMs(value) {
    const intervalMs = Number(value);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Visible refresh interval must be a positive number.");
    }
    this.visibleRefreshIntervalMs = intervalMs;
    this.scheduleNextRefresh();
    return this.getState();
  }

  refreshNow(reason = "manual") {
    if (this.inFlight) return this.inFlight;

    this.clearTimer();
    this.state = {
      ...this.state,
      status: this.state.quota ? this.state.status : "loading",
      error: null,
      refreshing: true,
      nextRefreshAt: null
    };
    this.emitState();

    this.inFlight = this.runRefresh(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  destroy() {
    this.clearTimer();
    this.removeAllListeners();
  }

  async runRefresh(reason) {
    try {
      const rawQuota = await this.readQuota(reason);
      if (!this.acceptQuotaSnapshot(rawQuota)) {
        this.failureCount = 0;
        this.state = {
          ...this.state,
          status: this.state.quota ? "ready" : "loading",
          error: null,
          refreshing: false
        };
        this.emitState();
        this.scheduleNextRefresh(this.driftRefreshIntervalMs);
        return this.getState();
      }
      this.recordHistory(rawQuota);
      const quota = this.withCurrentPaceAdvice(rawQuota, rawQuota.fetchedAt);
      const fetchedAt = quota.fetchedAt || new Date().toISOString();
      this.failureCount = 0;
      this.state = {
        ...this.state,
        status: "ready",
        quota,
        error: null,
        fromCache: false,
        refreshing: false,
        lastUpdatedAt: fetchedAt
      };
      await this.saveCache(quota);
      await this.saveHistory();
      this.emitState();
      this.scheduleNextRefresh();
    } catch (error) {
      this.failureCount += 1;
      this.state = {
        ...this.state,
        status: "error",
        error: serializeError(error),
        refreshing: false
      };
      this.emitState();
      this.scheduleNextRefresh(this.retryDelayMs());
    }

    return this.getState();
  }

  acceptQuotaSnapshot(rawQuota) {
    const acceptedQuota = this.state.quota;
    if (!acceptedQuota || !isQuotaDrift(acceptedQuota, rawQuota)) {
      this.pendingQuota = null;
      return true;
    }

    const candidate = quotaHistorySample(rawQuota);
    if (this.pendingQuota && hasSameWindowIdentity(this.pendingQuota.quota, candidate)) {
      this.pendingQuota = {
        quota: candidate,
        confirmations: this.pendingQuota.confirmations + 1
      };
    } else {
      this.pendingQuota = { quota: candidate, confirmations: 1 };
    }

    if (this.pendingQuota.confirmations >= QUOTA_DRIFT_CONFIRMATION_READS) {
      this.pendingQuota = null;
      return true;
    }

    return false;
  }

  async saveCache(quota) {
    const payload = {
      version: CACHE_VERSION,
      savedAt: new Date().toISOString(),
      quota
    };
    const tempPath = `${this.cachePath}.tmp`;
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.cachePath);
  }

  async loadHistory() {
    try {
      const payload = JSON.parse(await fs.readFile(this.historyPath, "utf8"));
      this.history = normalizeHistory(payload?.version === HISTORY_VERSION ? payload.samples : []);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.history = [];
      }
    }
    this.history = pruneHistory(this.history, Date.now());
    return this.history;
  }

  async saveHistory() {
    const payload = {
      version: HISTORY_VERSION,
      samples: this.history
    };
    const tempPath = `${this.historyPath}.tmp`;
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.historyPath);
  }

  recordHistory(quota) {
    const sample = quotaHistorySample(quota);
    if (!sample) return this.history;

    this.history = this.history.filter((entry) => entry.fetchedAt !== sample.fetchedAt);
    this.history.push(sample);
    this.history = pruneHistory(normalizeHistory(this.history), Date.parse(sample.fetchedAt));
    return this.history;
  }

  withCurrentPaceAdvice(quota, now = new Date().toISOString()) {
    return {
      ...quota,
      paceAdvice: buildPaceAdvice(quota, now || quota.fetchedAt, this.history)
    };
  }

  scheduleNextRefresh(delayMs) {
    if (!this.autoSchedule) return;

    this.clearTimer();
    const intervalMs = Number.isFinite(delayMs)
      ? Math.max(0, delayMs)
      : this.windowVisible
        ? this.visibleRefreshIntervalMs
        : this.hiddenRefreshIntervalMs;
    const nextRefreshAt = new Date(Date.now() + intervalMs).toISOString();
    this.state = {
      ...this.state,
      nextRefreshAt
    };
    this.timer = setTimeout(() => {
      this.refreshNow("scheduled").catch(() => {});
    }, intervalMs);
    this.emitState();
  }

  retryDelayMs() {
    const multiplier = Math.max(1, 2 ** Math.max(0, this.failureCount - 1));
    return Math.min(this.errorRetryMaxMs, this.errorRetryBaseMs * multiplier);
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  emitState() {
    this.emit("state", this.getState());
  }
}

function quotaHistorySample(quota) {
  const fetchedAt = quota?.fetchedAt || new Date().toISOString();
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return null;

  return {
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    primary: quotaWindowHistorySample(quota?.primary),
    secondary: quotaWindowHistorySample(quota?.secondary)
  };
}

function quotaWindowHistorySample(window) {
  if (!window) return null;
  const remainingPercent = Number(window.remainingPercent);
  return {
    remainingPercent: Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, remainingPercent)) : null,
    windowDurationMins: Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null,
    resetsAt: window.resetsAt || null
  };
}

function normalizeHistory(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((sample) => {
      const fetchedAtMs = Date.parse(sample?.fetchedAt || "");
      if (!Number.isFinite(fetchedAtMs)) return null;
      return {
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        primary: normalizeHistoryWindow(sample?.primary),
        secondary: normalizeHistoryWindow(sample?.secondary)
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
}

function normalizeHistoryWindow(window) {
  if (!window) return null;
  const remainingPercent = Number(window.remainingPercent);
  return {
    remainingPercent: Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, remainingPercent)) : null,
    windowDurationMins: Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null,
    resetsAt: window.resetsAt || null
  };
}

function pruneHistory(history, nowMs) {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const samplesWithinRetention = history
    .filter((sample) => {
      const fetchedAtMs = Date.parse(sample.fetchedAt || "");
      return Number.isFinite(fetchedAtMs) && safeNowMs - fetchedAtMs <= HISTORY_MAX_AGE_MS;
    })
    .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  const recentCutoffMs = safeNowMs - HISTORY_FINE_MAX_AGE_MS;
  const coarseCandidates = [];
  const recentSamples = [];

  for (const sample of samplesWithinRetention) {
    const fetchedAtMs = Date.parse(sample.fetchedAt || "");
    if (fetchedAtMs >= recentCutoffMs) {
      recentSamples.push(sample);
    } else {
      coarseCandidates.push(sample);
    }
  }

  return normalizeHistory([...downsampleDailyHistory(coarseCandidates), ...recentSamples.slice(-HISTORY_MAX_SAMPLES)]);
}

function downsampleDailyHistory(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const buckets = new Map();
  for (const sample of samples) {
    const dayKey = historyLocalDateKey(sample.fetchedAt);
    if (!dayKey) continue;
    if (!buckets.has(dayKey)) buckets.set(dayKey, []);
    buckets.get(dayKey).push(sample);
  }

  return [...buckets.values()]
    .flatMap((bucket) => representativeDailySamples(bucket))
    .sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
}

function representativeDailySamples(bucket) {
  const sorted = [...bucket].sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  if (sorted.length <= HISTORY_COARSE_MAX_SAMPLES_PER_DAY) return sorted;

  const selected = new Map();
  const add = (sample) => {
    if (sample?.fetchedAt) selected.set(sample.fetchedAt, sample);
  };

  add(sorted[0]);
  add(sorted[sorted.length - 1]);
  for (const key of ["primary", "secondary"]) {
    add(extremeRemainingSample(sorted, key, "min"));
    add(extremeRemainingSample(sorted, key, "max"));
  }

  return [...selected.values()].sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
}

function extremeRemainingSample(samples, key, mode) {
  let best = null;
  for (const sample of samples) {
    const remainingPercent = Number(sample?.[key]?.remainingPercent);
    if (!Number.isFinite(remainingPercent)) continue;
    if (!best || (mode === "min" ? remainingPercent < best.remainingPercent : remainingPercent > best.remainingPercent)) {
      best = { sample, remainingPercent };
    }
  }
  return best?.sample || null;
}

function historyLocalDateKey(isoString) {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function isQuotaDrift(acceptedQuota, candidateQuota) {
  const candidateAtMs = Date.parse(candidateQuota?.fetchedAt || "");
  if (!Number.isFinite(candidateAtMs)) return false;

  return ["primary", "secondary"].some((key) => {
    const acceptedWindow = acceptedQuota?.[key];
    const candidateWindow = candidateQuota?.[key];
    const acceptedRemaining = Number(acceptedWindow?.remainingPercent);
    const candidateRemaining = Number(candidateWindow?.remainingPercent);
    const acceptedResetAtMs = Date.parse(acceptedWindow?.resetsAt || "");
    const candidateResetAtMs = Date.parse(candidateWindow?.resetsAt || "");
    const acceptedDuration = Number(acceptedWindow?.windowDurationMins);
    const candidateDuration = Number(candidateWindow?.windowDurationMins);
    const remainingDrift =
      Number.isFinite(acceptedRemaining) &&
      Number.isFinite(candidateRemaining) &&
      candidateRemaining - acceptedRemaining >= QUOTA_DRIFT_REMAINING_THRESHOLD;
    const resetDrift =
      Number.isFinite(candidateResetAtMs) &&
      Math.abs(candidateResetAtMs - acceptedResetAtMs) > QUOTA_DRIFT_RESET_TOLERANCE_MS;
    const durationDrift =
      Number.isFinite(acceptedDuration) &&
      Number.isFinite(candidateDuration) &&
      acceptedDuration !== candidateDuration;
    return (
      Number.isFinite(acceptedResetAtMs) &&
      candidateAtMs < acceptedResetAtMs &&
      (remainingDrift || resetDrift || durationDrift)
    );
  });
}

function hasSameWindowIdentity(firstQuota, secondQuota) {
  let comparedWindows = 0;
  for (const key of ["primary", "secondary"]) {
    const firstWindow = firstQuota?.[key];
    const secondWindow = secondQuota?.[key];
    if (!firstWindow || !secondWindow) continue;

    const firstResetAtMs = Date.parse(firstWindow.resetsAt || "");
    const secondResetAtMs = Date.parse(secondWindow.resetsAt || "");
    if (!Number.isFinite(firstResetAtMs) || !Number.isFinite(secondResetAtMs)) return false;
    if (Number(firstWindow.windowDurationMins) !== Number(secondWindow.windowDurationMins)) return false;
    if (Math.abs(firstResetAtMs - secondResetAtMs) > QUOTA_DRIFT_RESET_TOLERANCE_MS) return false;
    comparedWindows += 1;
  }
  return comparedWindows > 0;
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error)
  };
}

module.exports = {
  QuotaStore,
  HISTORY_FINE_MAX_AGE_MS,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_SAMPLES,
  HISTORY_COARSE_MAX_SAMPLES_PER_DAY,
  VISIBLE_REFRESH_INTERVAL_MS,
  HIDDEN_REFRESH_INTERVAL_MS,
  QUOTA_DRIFT_REFRESH_INTERVAL_MS,
  ERROR_RETRY_BASE_MS,
  ERROR_RETRY_MAX_MS
};
