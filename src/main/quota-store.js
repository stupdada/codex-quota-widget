const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { getQuota } = require("./quota-service");

const CACHE_FILE_NAME = "quota-cache.json";
const CACHE_VERSION = 1;
const VISIBLE_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const HIDDEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const ERROR_RETRY_BASE_MS = 60 * 1000;
const ERROR_RETRY_MAX_MS = 5 * 60 * 1000;

class QuotaStore extends EventEmitter {
  constructor({
    userDataPath,
    readQuota = getQuota,
    visibleRefreshIntervalMs = VISIBLE_REFRESH_INTERVAL_MS,
    hiddenRefreshIntervalMs = HIDDEN_REFRESH_INTERVAL_MS,
    errorRetryBaseMs = ERROR_RETRY_BASE_MS,
    errorRetryMaxMs = ERROR_RETRY_MAX_MS,
    autoSchedule = true
  }) {
    super();
    if (!userDataPath) {
      throw new Error("QuotaStore requires a userDataPath.");
    }

    this.cachePath = path.join(userDataPath, CACHE_FILE_NAME);
    this.readQuota = readQuota;
    this.visibleRefreshIntervalMs = visibleRefreshIntervalMs;
    this.hiddenRefreshIntervalMs = hiddenRefreshIntervalMs;
    this.errorRetryBaseMs = errorRetryBaseMs;
    this.errorRetryMaxMs = errorRetryMaxMs;
    this.autoSchedule = autoSchedule;
    this.windowVisible = true;
    this.failureCount = 0;
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
    try {
      const cache = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
      if (cache?.version === CACHE_VERSION && cache.quota) {
        this.state = {
          ...this.state,
          status: "ready",
          quota: cache.quota,
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

  setWindowVisible(value) {
    this.windowVisible = Boolean(value);
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
      const quota = await this.readQuota(reason);
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

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error)
  };
}

module.exports = {
  QuotaStore,
  VISIBLE_REFRESH_INTERVAL_MS,
  HIDDEN_REFRESH_INTERVAL_MS,
  ERROR_RETRY_BASE_MS,
  ERROR_RETRY_MAX_MS
};
