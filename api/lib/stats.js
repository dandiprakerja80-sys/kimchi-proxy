const stats = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  recentRequests: [],
  logs: [],
};

const MAX_RECENT = 100;
const MAX_LOGS = 200;
const EST_COST_PER_1K_INPUT = 0.0006;
const EST_COST_PER_1K_OUTPUT = 0.0024;

function logRequest(data) {
  stats.totalRequests++;
  stats.totalInputTokens += data.inputTokens || 0;
  stats.totalOutputTokens += data.outputTokens || 0;

  const entry = {
    id: stats.totalRequests,
    model: data.model || "unknown",
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    keyIndex: data.keyIndex ?? 0,
    status: data.status || 200,
    elapsed: data.elapsed || 0,
    timestamp: Date.now(),
  };

  stats.recentRequests.unshift(entry);
  if (stats.recentRequests.length > MAX_RECENT) {
    stats.recentRequests = stats.recentRequests.slice(0, MAX_RECENT);
  }

  addLog({
    level: data.status >= 400 ? "error" : "info",
    message: `${data.method || "POST"} ${data.model} in:${data.inputTokens || 0} out:${data.outputTokens || 0} ${data.elapsed}ms key:${data.keyIndex}`,
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

  return {
    totalRequests: stats.totalRequests,
    totalInputTokens: stats.totalInputTokens,
    totalOutputTokens: stats.totalOutputTokens,
    estimatedCost: cost,
    recentRequests: stats.recentRequests,
    logs: stats.logs,
  };
}

module.exports = { logRequest, addLog, getStats };
