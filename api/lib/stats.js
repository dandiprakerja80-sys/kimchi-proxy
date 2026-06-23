const stats = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalErrors: 0,
  recentRequests: [],
  errors: [],
  logs: [],
  keys: {
    total: 0,
    exhausted: new Set(),
    throttled: new Set(),
    errors: new Map(),
  },
};

const MAX_RECENT = 500;
const MAX_ERRORS = 500;
const MAX_LOGS = 500;
const EST_COST_PER_1K_INPUT = 0.0006;
const EST_COST_PER_1K_OUTPUT = 0.0024;

function markKeyExhausted(index) {
  stats.keys.exhausted.add(index);
}

function markKeyThrottled(index) {
  stats.keys.throttled.add(index);
}

function unmarkKeyThrottled(index) {
  stats.keys.throttled.delete(index);
}

function recordKeyError(index, error) {
  const key = `key_${index}`;
  const prev = stats.keys.errors.get(key) || { count: 0, lastError: "", lastTime: 0 };
  stats.keys.errors.set(key, {
    count: prev.count + 1,
    lastError: error,
    lastTime: Date.now(),
  });
}

function logRequest(data) {
  stats.totalRequests++;
  stats.totalInputTokens += data.inputTokens || 0;
  stats.totalOutputTokens += data.outputTokens || 0;

  if (data.status >= 400) {
    stats.totalErrors++;
  }

  const entry = {
    id: stats.totalRequests,
    model: data.model || "unknown",
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    keyIndex: data.keyIndex ?? 0,
    status: data.status || 200,
    elapsed: data.elapsed || 0,
    error: data.error || null,
    timestamp: Date.now(),
  };

  stats.recentRequests.unshift(entry);
  if (stats.recentRequests.length > MAX_RECENT) {
    stats.recentRequests = stats.recentRequests.slice(0, MAX_RECENT);
  }

  if (data.status >= 400 || data.error) {
    stats.errors.unshift({
      id: stats.errors.length + 1,
      request_id: stats.totalRequests,
      model: data.model,
      status: data.status,
      keyIndex: data.keyIndex,
      error: data.error || `HTTP ${data.status}`,
      details: data.details || null,
      timestamp: Date.now(),
    });
    if (stats.errors.length > MAX_ERRORS) {
      stats.errors = stats.errors.slice(0, MAX_ERRORS);
    }
  }

  addLog({
    level: data.status >= 400 ? "error" : "info",
    message: `${data.model} in:${data.inputTokens || 0} out:${data.outputTokens || 0} ${data.elapsed}ms key:${data.keyIndex} status:${data.status}${data.error ? " err:" + data.error : ""}`,
    timestamp: Date.now(),
  });

  return entry;
}

function addLog(entry) {
  stats.logs.unshift({ ...entry, id: stats.logs.length + 1 });
  if (stats.logs.length > MAX_LOGS) {
    stats.logs = stats.logs.slice(0, MAX_LOGS);
  }
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
  const filtered = filterByRange(stats.recentRequests, range);
  const filteredErrors = filterByRange(stats.errors, range);

  let totalIn = 0;
  let totalOut = 0;
  let totalReqs = 0;
  let totalErrs = 0;

  for (const r of filtered) {
    totalReqs++;
    totalIn += r.inputTokens || 0;
    totalOut += r.outputTokens || 0;
    if (r.status >= 400) totalErrs++;
  }

  const cost = (totalIn / 1000) * EST_COST_PER_1K_INPUT + (totalOut / 1000) * EST_COST_PER_1K_OUTPUT;

  const keyErrors = {};
  stats.keys.errors.forEach((val, key) => {
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
    keys: {
      total: totalKeys,
      active: totalKeys - stats.keys.exhausted.size,
      exhausted: stats.keys.exhausted.size,
      throttled: stats.keys.throttled.size,
      errors: keyErrors,
    },
    recentRequests: filtered.slice(0, 100),
    errors: filteredErrors.slice(0, 50),
    logs: stats.logs.slice(0, 150),
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
