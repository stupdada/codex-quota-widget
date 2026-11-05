const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { deriveQuotaSignal, normalizeCycle } = require("./quota-signal");

const DEFAULT_PORTS = Object.freeze([8768, 8769, 8770, 8771, 8772]);
const DEFAULT_USAGE_RANGE = "cycle_5h";
const MIN_BACKEND_PRODUCT_VERSION = 15;
const USAGE_RANGES = new Set(["cycle_5h", "cycle_7d", "last_3h", "today", "week"]);
const RANGE_LABELS = Object.freeze({
  cycle_5h: "5h",
  cycle_7d: "7d",
  last_3h: "近 3h",
  today: "今天",
  week: "本周"
});
const HIDDEN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function normalizeUsageRange(value) {
  return USAGE_RANGES.has(value) ? value : DEFAULT_USAGE_RANGE;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUsd(value) {
  const number = finiteNumberOrNull(value);
  if (number === null) return null;
  const absolute = Math.abs(number);
  const digits = absolute === 0 || absolute >= 1 ? 2 : absolute >= 0.01 ? 3 : absolute >= 0.0001 ? 4 : 6;
  return `$${number.toFixed(digits)}`;
}

function normalizeUsage(rawUsage, requestedRange) {
  const range = normalizeUsageRange(rawUsage?.range || requestedRange);
  const costBase = finiteNumberOrNull(rawUsage?.cost_base ?? rawUsage?.costBase);
  const costMax = finiteNumberOrNull(rawUsage?.cost_max ?? rawUsage?.costMax);
  const costComplete = Boolean(rawUsage?.cost_complete ?? rawUsage?.costComplete);
  const dataComplete = Boolean(rawUsage?.data_complete ?? rawUsage?.dataComplete);
  let displayValue = "--";
  if (costBase !== null && costMax !== null) {
    displayValue = `≈${formatUsd((costBase + costMax) / 2)}`;
  } else if (costBase !== null || costMax !== null) {
    const value = costBase ?? costMax;
    displayValue = costComplete && dataComplete ? `≈${formatUsd(value)}` : `≥${formatUsd(value)}`;
  }
  return {
    range,
    label: RANGE_LABELS[range],
    detailLabel: RANGE_LABELS[range],
    start: rawUsage?.start || null,
    end: rawUsage?.end || null,
    costBase,
    costMax,
    costComplete,
    dataComplete,
    displayValue
  };
}

function normalizeWidgetPayload(payload, requestedRange = DEFAULT_USAGE_RANGE) {
  if (!payload || typeof payload !== "object") throw new Error("Token 仪表盘返回了无效的小组件数据");
  const generatedAt = payload.generated_at || payload.generatedAt || new Date().toISOString();
  const rawCycles = payload.cycles || {};
  let fiveHour = normalizeCycle(rawCycles.five_hour ?? rawCycles.fiveHour, generatedAt);
  const sevenDay = normalizeCycle(rawCycles.seven_day ?? rawCycles.sevenDay, generatedAt);
  const generatedAtMs = Date.parse(generatedAt);
  if (
    fiveHour?.stale
    && (!fiveHour.resetAt || (Number.isFinite(generatedAtMs) && Date.parse(fiveHour.resetAt) <= generatedAtMs))
  ) {
    fiveHour = null;
  }
  const cycles = { fiveHour, sevenDay };
  return {
    version: payload.version ?? 1,
    generatedAt,
    cycles,
    usage: normalizeUsage(payload.usage, requestedRange),
    quotaSignal: deriveQuotaSignal(cycles),
    connectionStatus: "ready"
  };
}

function markWidgetUnavailable(widget) {
  if (!widget) {
    return {
      version: 1,
      generatedAt: null,
      cycles: { fiveHour: null, sevenDay: null },
      usage: normalizeUsage(null, DEFAULT_USAGE_RANGE),
      quotaSignal: deriveQuotaSignal(null, { connectionUnavailable: true }),
      connectionStatus: "unavailable"
    };
  }
  return {
    ...widget,
    quotaSignal: deriveQuotaSignal(widget.cycles, { connectionUnavailable: true }),
    connectionStatus: "unavailable"
  };
}

function requestJson(urlValue, options = {}) {
  const url = new URL(urlValue);
  const transport = url.protocol === "https:" ? https : http;
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method || "GET",
        headers: body
          ? { "content-type": "application/json", "content-length": String(body.length) }
          : undefined,
        timeout: options.timeoutMs || 1500
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
            const error = new Error(`Token 仪表盘 HTTP ${response.statusCode || 0}`);
            error.statusCode = response.statusCode;
            reject(error);
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(new Error(`Token 仪表盘返回了无效 JSON：${error.message}`));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Token 仪表盘请求超时")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function executableCandidates({ appPath, resourcesPath, env = process.env }) {
  const values = [];
  if (env.CODEX_TOKEN_DASHBOARD_EXE) values.push(env.CODEX_TOKEN_DASHBOARD_EXE);
  if (resourcesPath) values.push(path.join(resourcesPath, "backend", "CodexTokenDashboard-Slim.exe"));
  if (appPath) {
    values.push(path.join(appPath, "backend", "CodexTokenDashboard-Slim.exe"));
    values.push(path.resolve(appPath, "..", "TOKEN", "output", "CodexTokenDashboard-Slim.exe"));
  }
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenDashboardClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.userDataPath = options.userDataPath;
    this.cachePath = path.join(this.userDataPath, "token-widget-cache.json");
    this.pidFile = options.pidFile || path.join(os.homedir(), ".codex", "logs", "token_speed_dashboard-agent.json");
    this.candidatePorts = options.candidatePorts || DEFAULT_PORTS;
    this.visibleRefreshIntervalMs = options.visibleRefreshIntervalMs || 3 * 60 * 1000;
    this.usageRange = normalizeUsageRange(options.usageRange);
    this.requestJson = options.requestJson || requestJson;
    this.readFile = options.readFile || fs.readFile;
    this.writeFile = options.writeFile || fs.writeFile;
    this.mkdir = options.mkdir || fs.mkdir;
    this.access = options.access || fs.access;
    this.spawn = options.spawn || spawn;
    this.sleep = options.sleep || delay;
    this.appPath = options.appPath || path.resolve(__dirname, "../..");
    this.resourcesPath = options.resourcesPath || process.resourcesPath || null;
    this.env = options.env || process.env;
    this.autoSchedule = options.autoSchedule !== false;
    this.windowVisible = true;
    this.agentPort = null;
    this.refreshPromise = null;
    this.startPromise = null;
    this.timer = null;
    this.destroyed = false;
    this.state = {
      status: "loading",
      widget: null,
      error: null,
      refreshing: false,
      fromCache: false
    };
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async loadCache() {
    try {
      const payload = JSON.parse(await this.readFile(this.cachePath, "utf8"));
      const widget = normalizeWidgetPayload(payload.widget, payload.usageRange || this.usageRange);
      this.state = {
        status: "error",
        widget: markWidgetUnavailable(widget),
        error: { message: "正在连接 Token 仪表盘，当前显示上次数据" },
        refreshing: false,
        fromCache: true
      };
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`Failed to read Token widget cache: ${error.message}`);
    }
    return this.getState();
  }

  setWindowVisible(value) {
    this.windowVisible = Boolean(value);
    this.scheduleRefresh();
  }

  setVisibleRefreshIntervalMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error("Refresh interval must be a positive number.");
    this.visibleRefreshIntervalMs = number;
    this.scheduleRefresh();
  }

  setUsageRange(value) {
    this.usageRange = normalizeUsageRange(value);
    return this.usageRange;
  }

  async refreshNow() {
    if (this.refreshPromise) return this.refreshPromise;
    this.state = { ...this.state, refreshing: true };
    this.emit("state", this.getState());
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
      this.scheduleRefresh();
    });
    return this.refreshPromise;
  }

  async performRefresh() {
    try {
      let port = await this.ensureAgentPort();
      let payload;
      try {
        payload = await this.requestWidget(port);
      } catch (firstError) {
        this.agentPort = null;
        port = await this.ensureAgentPort({ forceStart: true, excludedPorts: [port] });
        payload = await this.requestWidget(port);
      }
      const widget = normalizeWidgetPayload(payload, this.usageRange);
      this.state = { status: "ready", widget, error: null, refreshing: false, fromCache: false };
      await this.saveCache(payload).catch((error) => console.warn(`Failed to save Token widget cache: ${error.message}`));
    } catch (error) {
      this.state = {
        ...this.state,
        status: "error",
        widget: markWidgetUnavailable(this.state.widget),
        error: { message: error?.message || String(error) },
        refreshing: false
      };
    }
    this.emit("state", this.getState());
    return this.getState();
  }

  async requestWidget(port) {
    const query = new URLSearchParams({ usage_range: this.usageRange });
    return this.requestJson(`http://127.0.0.1:${port}/api/widget?${query}`, { timeoutMs: 5000 });
  }

  async openDashboard() {
    const port = await this.ensureAgentPort();
    return { ok: true, port, url: `http://127.0.0.1:${port}/focus` };
  }

  async ensureAgentPort(options = {}) {
    if (!options.forceStart && this.agentPort && !options.excludedPorts?.includes(this.agentPort)) {
      const healthy = await this.isHealthyPort(this.agentPort);
      if (healthy) return this.agentPort;
      this.agentPort = null;
    }
    const discovered = await this.discoverAgentPort(options.excludedPorts || []);
    if (discovered && !options.forceStart) {
      this.agentPort = discovered;
      return discovered;
    }
    const started = await this.startDashboardAgent(options.excludedPorts || []);
    this.agentPort = started;
    return started;
  }

  async readPidPort() {
    try {
      const record = JSON.parse(await this.readFile(this.pidFile, "utf8"));
      const port = Number(record?.port);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    } catch (_error) {
      return null;
    }
  }

  async discoverAgentPort(excludedPorts = []) {
    const pidPort = await this.readPidPort();
    const candidates = [...new Set([pidPort, ...this.candidatePorts].filter(Boolean))].filter(
      (port) => !excludedPorts.includes(port)
    );
    for (const port of candidates) {
      if (await this.isHealthyPort(port)) return port;
    }
    return null;
  }

  async isHealthyPort(port) {
    try {
      const health = await this.requestJson(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 800 });
      return health?.app_id === "codex-token-dashboard"
        && Number(health?.product_version || 0) >= MIN_BACKEND_PRODUCT_VERSION;
    } catch (_error) {
      return false;
    }
  }

  async findDashboardExecutable() {
    for (const candidate of executableCandidates({
      appPath: this.appPath,
      resourcesPath: this.resourcesPath,
      env: this.env
    })) {
      try {
        await this.access(candidate);
        return candidate;
      } catch (_error) {
        // Try the next configured/package/development candidate.
      }
    }
    return null;
  }

  async startDashboardAgent(excludedPorts = []) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const executable = await this.findDashboardExecutable();
      if (!executable) {
        throw new Error("Token 仪表盘服务未运行，且未找到 CodexTokenDashboard-Slim.exe");
      }
      const child = this.spawn(executable, ["--background"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore"
      });
      let launchError = null;
      child.once?.("error", (error) => {
        launchError = error;
      });
      child.once?.("exit", (code) => {
        if (code && !launchError) launchError = new Error(`Token 仪表盘后台退出，代码 ${code}`);
      });
      child.unref?.();
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await this.sleep(300);
        if (launchError) throw launchError;
        const port = await this.discoverAgentPort(excludedPorts);
        if (port) return port;
      }
      throw new Error("Token 仪表盘后台启动超时");
    })().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async saveCache(payload) {
    await this.mkdir(path.dirname(this.cachePath), { recursive: true });
    await this.writeFile(
      this.cachePath,
      `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), usageRange: this.usageRange, widget: payload }, null, 2)}\n`,
      "utf8"
    );
  }

  scheduleRefresh() {
    if (!this.autoSchedule || this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    const interval = this.windowVisible ? this.visibleRefreshIntervalMs : HIDDEN_REFRESH_INTERVAL_MS;
    this.timer = setTimeout(() => this.refreshNow().catch(() => {}), interval);
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = {
  DEFAULT_USAGE_RANGE,
  HIDDEN_REFRESH_INTERVAL_MS,
  TokenDashboardClient,
  executableCandidates,
  markWidgetUnavailable,
  normalizeUsage,
  normalizeUsageRange,
  normalizeWidgetPayload,
  requestJson
};
