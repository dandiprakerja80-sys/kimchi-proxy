const fs = require("fs");
const path = require("path");

const STATS_FILE = "/tmp/kimchi-stats.json";
const MAX_RECENT = 500;
const MAX_ERRORS = 500;
const MAX_LOGS = 500;
const EST_COST_PER_1K_INPUT = 0.0006;
const EST_COST_PER_1K_OUTPUT = 0.0024;

let _stats = null;

function load() {
  if (_stats) return _stats;
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, "utf-8");
      _stats = JSON.parse(raw);
      _stats.keys = _stats.keys || { exhausted: [], throttled: [], errors: {} };
      _stats.keys.exhausted = new Set(_stats.keys.exhausted);
      _stats.keys.throttled = new Set(_stats.keys.throttled);
      _stats.keys.errors = new Map(Object.entries(_stats.keys.errors || {}));
      return _stats;
    }
  } catch {}
  _stats = createFreshStats();
  return _stats;
}

function createFreshStats() {
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalErrors: 0,
    recentRequests: [],
    errors: [],
    logs: [],
    keys: {
      exhausted: new Set(),
      throttled: new Set(),
      errors: new Map(),
    },
  };
}

function save() {
  if (!_stats) return;
  try {
    const out = {
      ..._stats,
      keys: {
        exhausted: [..._stats.keys.exhausted],
        throttled: [..._stats.keys.throttled],
        errors: Object.fromEntries(_stats.keys.errors),
      },
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(out), "utf-8");
  } catch {}
}

function markKeyExhausted(index) {
  const s = load();
  s.keys.exhausted.add(index);
  save();
}

function markKeyThrottled(index) {
  const s = load();
  s.keys.throttled.add(index);
  save();
}

function unmarkKeyThrottled(index) {
  const s = load();
  s.keys.throttled.delete(index);
  save();
}

function recordKeyError(index, error) {
  const s = load();
  const key = `key_${index}`;
  const prev = s.keys.errors.get(key) || { count: 0, lastError: "", lastTime: 0 };
  s.keys.errors.set(key, {
    count: prev.count + 1,
    lastError: error,
    lastTime: Date.now(),
  });
  save();
}

function logRequest(data) {
  const s = load();
  s.totalRequests++;
  s.totalInputTokens += data.inputTokens || 0;
  s.totalOutputTokens += data.outputTokens || 0;

  if (data.status >= 400) {
    s.totalErrors++;
  }

  const entry = {
    id: s.totalRequests,
    model: data.model || "unknown",
    provider: data.provider || "kimchi",
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    keyIndex: data.keyIndex ?? 0,
    status: data.status || 200,
    elapsed: data.elapsed || 0,
    error: data.error || null,
    timestamp: Date.now(),
  };

  s.recentRequests.unshift(entry);
  if (s.recentRequests.length > MAX_RECENT) {
    s.recentRequests = s.recentRequests.slice(0, MAX_RECENT);
  }

  if (data.status >= 400 || data.error) {
    s.errors.unshift({
      id: s.errors.length + 1,
      request_id: s.totalRequests,
      model: data.model,
      status: data.status,
      keyIndex: data.keyIndex,
      error: data.error || `HTTP ${data.status}`,
      details: data.details || null,
      timestamp: Date.now(),
    });
    if (s.errors.length > MAX_ERRORS) {
      s.errors = s.errors.slice(0, MAX_ERRORS);
    }
  }

  s.logs.unshift({
    id: s.logs.length + 1,
    level: data.status >= 400 ? "error" : "info",
    message: `${data.model} (${data.provider || "kimchi"}) in:${data.inputTokens || 0} out:${data.outputTokens || 0} ${data.elapsed}ms key:${data.keyIndex} status:${data.status}${data.error ? " err:" + data.error : ""}`,
    timestamp: Date.now(),
  });
  if (s.logs.length > MAX_LOGS) {
    s.logs = s.logs.slice(0, MAX_LOGS);
  }

  save();
  return entry;
}

function addLog(entry) {
  const s = load();
  s.logs.unshift({ ...entry, id: s.logs.length + 1 });
  if (s.logs.length > MAX_LOGS) {
    s.logs = s.logs.slice(0, MAX_LOGS);
  }
  save();
}

function filterByRange(arr, range) {
  if (range === "all") return arr;
  const now = Date.now();
  let since = 0;
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    since = d.getTime();
  } else if (range === "week") {
    since = now - 7 * 24 * 60 * 60 * 1000;
  } else if (range === "month") {
    since = now - 30 * 24 * 60 * 60 * 1000;
  }
  return arr.filter((e) => e.timestamp >= since);
}

function getStats(range) {
  const s = load();
  const filtered = filterByRange(s.recentRequests, range);
  const filteredErrors = filterByRange(s.errors, range);

  let totalIn = 0;
  let totalOut = 0;
  let totalReqs = 0;
  let totalErrs = 0;
  const providerStats = {};

  for (const r of filtered) {
    totalReqs++;
    totalIn += r.inputTokens || 0;
    totalOut += r.outputTokens || 0;
    if (r.status >= 400) totalErrs++;

    const provider = r.provider || "kimchi";
    if (!providerStats[provider]) {
      providerStats[provider] = { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
    }
    providerStats[provider].requests++;
    providerStats[provider].inputTokens += r.inputTokens || 0;
    providerStats[provider].outputTokens += r.outputTokens || 0;
    if (r.status >= 400) providerStats[provider].errors++;
  }

  const cost = (totalIn / 1000) * EST_COST_PER_1K_INPUT + (totalOut / 1000) * EST_COST_PER_1K_OUTPUT;

  const keyErrors = {};
  s.keys.errors.forEach((val, key) => {
    keyErrors[key] = val;
  });

  const keysRaw = process.env.KIMCHI_API_KEYS || "";
  const totalKeys = keysRaw ? keysRaw.split(/[,\s]+/).filter(Boolean).length : 0;

  return {
    range,
    totalRequests: totalReqs,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalErrors: totalErrs,
    estimatedCost: cost,
    providers: providerStats,
    keys: {
      total: totalKeys,
      active: totalKeys - s.keys.exhausted.size,
      exhausted: s.keys.exhausted.size,
      throttled: s.keys.throttled.size,
      errors: keyErrors,
    },
    recentRequests: filtered.slice(0, 100),
    errors: filteredErrors.slice(0, 50),
    logs: s.logs.slice(0, 150),
  };
}

module.exports = {
  logRequest,
  addLog,
  getStats,
  markKeyExhausted,
  markKeyThrottled,
  unmarkKeyThrottled,
  recordKeyError,
};
