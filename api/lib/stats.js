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

const MAX_RECENT = 100;
const MAX_ERRORS = 200;
const MAX_LOGS = 300;
const EST_COST_PER_1K_INPUT = 0.0006;
const EST_COST_PER_1K_OUTPUT = 0.0024;

function setKeyTotal(count) {
  stats.keys.total = count;
}

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
    const errEntry = {
      id: stats.errors.length + 1,
      request_id: stats.totalRequests,
      model: data.model,
      status: data.status,
      keyIndex: data.keyIndex,
      error: data.error || `HTTP ${data.status}`,
      details: data.details || null,
      timestamp: Date.now(),
    };
    stats.errors.unshift(errEntry);
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
  stats.logs.unshift({
    ...entry,
    id: stats.logs.length + 1,
  });
  if (stats.logs.length > MAX_LOGS) {
    stats.logs = stats.logs.slice(0, MAX_LOGS);
  }
}

function getStats() {
  const cost =
    (stats.totalInputTokens / 1000) * EST_COST_PER_1K_INPUT +
    (stats.totalOutputTokens / 1000) * EST_COST_PER_1K_OUTPUT;

  const keyErrors = {};
  stats.keys.errors.forEach((val, key) => {
    keyErrors[key] = val;
  });

  const keysRaw = process.env.KIMCHI_API_KEYS || "";
  const totalKeys = keysRaw ? keysRaw.split(/[,\s]+/).filter(Boolean).length : 0;

  return {
    totalRequests: stats.totalRequests,
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    totalErrors: stats.totalErrors,
    estimatedCost: cost,
    keys: {
      total: totalKeys,
      active: totalKeys - stats.keys.exhausted.size,
      exhausted: stats.keys.exhausted.size,
      throttled: stats.keys.throttled.size,
      errors: keyErrors,
    },
    recentRequests: stats.recentRequests,
    errors: stats.errors.slice(0, 50),
    logs: stats.logs.slice(0, 150),
  };
}

module.exports = {
  logRequest,
  addLog,
  getStats,
  setKeyTotal,
  markKeyExhausted,
  markKeyThrottled,
  unmarkKeyThrottled,
  recordKeyError,
};
