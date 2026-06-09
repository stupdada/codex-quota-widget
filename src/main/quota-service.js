const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildPaceAdvice } = require("./pace-advice");

const DEFAULT_TIMEOUT_MS = 12000;

function resolveCodexPath() {
  const codexBinRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
    : null;
  const directCandidates = [
    process.env.CODEX_CLI_PATH,
    codexBinRoot ? path.join(codexBinRoot, "codex.exe") : null
  ].filter(Boolean);

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const versionedCandidate = codexBinRoot ? findLatestCodexBinCandidate(codexBinRoot) : null;
  if (versionedCandidate) return versionedCandidate;

  return "codex";
}

function findLatestCodexBinCandidate(codexBinRoot) {
  if (!fs.existsSync(codexBinRoot)) return null;

  return fs
    .readdirSync(codexBinRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(codexBinRoot, entry.name, "codex.exe"))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((a, b) => {
      const aTime = fs.statSync(a).mtimeMs;
      const bTime = fs.statSync(b).mtimeMs;
      return bTime - aTime;
    })[0] ?? null;
}

async function getQuota() {
  const response = await requestRateLimits();
  const snapshot = response.rateLimitsByLimitId?.codex;

  if (!snapshot) {
    throw new Error("Codex did not return the codex rate-limit snapshot.");
  }

  return normalizeSnapshot(snapshot);
}

function normalizeSnapshot(snapshot) {
  const primary = normalizeWindow(snapshot.primary);
  const secondary = normalizeWindow(snapshot.secondary);
  const activeWindow = primary || secondary;
  if (!activeWindow) {
    throw new Error("Codex rate-limit snapshot does not include a usable quota window.");
  }
  const normalized = {
    limitId: snapshot.limitId ?? "codex",
    limitName: snapshot.limitName ?? "Codex",
    planType: snapshot.planType ?? "unknown",
    reachedType: snapshot.rateLimitReachedType ?? null,
    credits: snapshot.credits ?? null,
    primary,
    secondary,
    remainingPercent: activeWindow.remainingPercent,
    usedPercent: activeWindow.usedPercent,
    resetsAt: activeWindow.resetsAt,
    fetchedAt: new Date().toISOString()
  };

  return {
    ...normalized,
    paceAdvice: buildPaceAdvice(normalized, normalized.fetchedAt)
  };
}

function normalizeWindow(window) {
  if (!window) return null;
  const usedPercent = normalizeUsedPercent(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: normalizeResetTime(window.resetsAt)
  };
}

function normalizeUsedPercent(value) {
  const usedPercent = Number(value);
  if (!Number.isFinite(usedPercent)) {
    throw new Error("Codex quota window is missing a numeric usedPercent.");
  }
  return clampPercent(usedPercent);
}

function normalizeResetTime(value) {
  if (value === null || value === undefined) return null;
  const timestampSeconds = Number(value);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error("Codex quota window has an invalid reset timestamp.");
  }
  return new Date(timestampSeconds * 1000).toISOString();
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function requestRateLimits() {
  const codexPath = resolveCodexPath();
  const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  const cleanup = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
    }
    pending.clear();
    if (!child.killed) child.kill();
  };

  const send = (method, params) => {
    const id = nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      handleMessage(line, pending);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });

    child.once("exit", (code) => {
      if (pending.size > 0) {
        cleanup();
        reject(new Error(stderr || `Codex app-server exited with code ${code}`));
      }
    });

    (async () => {
      try {
        await send("initialize", {
          clientInfo: {
            name: "codex-quota-widget",
            title: "Codex Quota Widget",
            version: "0.1.1"
          },
          capabilities: null
        });
        const result = await send("account/rateLimits/read");
        cleanup();
        resolve(result);
      } catch (error) {
        cleanup();
        reject(new Error(stderr || error.message));
      }
    })();
  });
}

function handleMessage(line, pending) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    rejectPendingRequests(pending, new Error(`Codex app-server returned invalid JSON: ${error.message}`));
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  const request = pending.get(message.id);
  if (!request) return;

  clearTimeout(request.timer);
  pending.delete(message.id);

  if (message.error) {
    request.reject(new Error(message.error.message || JSON.stringify(message.error)));
  } else {
    request.resolve(message.result);
  }
}

function rejectPendingRequests(pending, error) {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    pending.delete(id);
    request.reject(error);
  }
}

module.exports = { getQuota, normalizeSnapshot, resolveCodexPath };
