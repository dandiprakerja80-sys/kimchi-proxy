const fs = require("fs");

const STATS_FILE = "/tmp/kimchi-stats.json";
const BLOB_PATHNAME = "kimchi-proxy/stats.json";
const MAX_RECENT = 500;
const MAX_ERRORS = 500;
const MAX_LOGS = 50;
const EST_COST_PER_1K_INPUT = 0.0006;
const EST_COST_PER_1K_OUTPUT = 0.0024;

let _stats = null;
let _saveTimer = null;
let _savePromise = null;
let _blobSuspended = false;

const CF_LOGS_PER_KEY = 5;
const SAVE_DEBOUNCE_MS = 1000;
const PERSIST_STATS = process.env.PERSIST_STATS !== "false";

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
    cfState: {
      nextIndex: 0,
      exhausted: [],
      throttled: [],
      slow: [],
      logs: {},
    },
  };
}

function normalizeCfState(raw) {
  if (!raw || typeof raw !== "object") {
    return { nextIndex: 0, exhausted: [], throttled: [], slow: [], logs: {} };
  }
  return {
    nextIndex: typeof raw.nextIndex === "number" ? raw.nextIndex : 0,
    exhausted: Array.isArray(raw.exhausted) ? raw.exhausted : [],
    throttled: Array.isArray(raw.throttled) ? raw.throttled : [],
    slow: Array.isArray(raw.slow) ? raw.slow : [],
    logs: raw.logs && typeof raw.logs === "object" ? raw.logs : {},
  };
}

function serialize(stats) {
  return {
    ...stats,
    keys: {
      exhausted: [...stats.keys.exhausted],
      throttled: [...stats.keys.throttled],
      errors: Object.fromEntries(stats.keys.errors),
    },
    cfState: normalizeCfState(stats.cfState),
  };
}

function deserialize(raw) {
  return {
    ...raw,
    keys: {
      exhausted: new Set(raw.keys?.exhausted || []),
      throttled: new Set(raw.keys?.throttled || []),
      errors: new Map(Object.entries(raw.keys?.errors || {})),
    },
    cfState: normalizeCfState(raw.cfState),
  };
}

async function loadFromBlob() {
  if (!PERSIST_STATS || _blobSuspended || !process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = require("@vercel/blob");
    const { blobs } = await list({ prefix: BLOB_PATHNAME, limit: 1 });
    const blob = blobs.find((b) => b.pathname === BLOB_PATHNAME);
    if (!blob) return null;
    const res = await fetch(`${blob.url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes("blocked") || text.includes("suspended")) {
      _blobSuspended = true;
      console.error("[stats] blob store suspended or blocked, switching to ephemeral mode");
      return null;
    }
    return text ? deserialize(JSON.parse(text)) : null;
  } catch (e) {
    if (String(e.message).toLowerCase().includes("suspended") || String(e.message).toLowerCase().includes("blocked")) {
      _blobSuspended = true;
      console.error("[stats] blob store suspended or blocked, switching to ephemeral mode");
    } else {
      console.error("[stats] blob load failed:", e.message);
    }
    return null;
  }
}

async function saveToBlob(payload) {
  if (!PERSIST_STATS || _blobSuspended || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { put } = require("@vercel/blob");
    await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  } catch (e) {
    const msg = String(e.message).toLowerCase();
    if (msg.includes("suspended") || msg.includes("blocked")) {
      _blobSuspended = true;
      console.error("[stats] blob store suspended or blocked, switching to ephemeral mode");
    } else {
      console.error("[stats] blob save failed:", e.message);
    }
  }
}

async function load(force = false) {
  if (_stats && !force) return _stats;

  const blobStats = await loadFromBlob();
  if (blobStats) {
    _stats = blobStats;
    return _stats;
  }

  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, "utf-8");
      _stats = deserialize(JSON.parse(raw));
      return _stats;
    }
  } catch {}

  _stats = createFreshStats();
  return _stats;
}

async function flushSave() {
  if (!_stats) return;
  if (_savePromise) return _savePromise;
  _savePromise = (async () => {
    const payload = serialize(_stats);
    await saveToBlob(payload);
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(payload), "utf-8");
    } catch {}
  })();
  try {
    await _savePromise;
  } finally {
    _savePromise = null;
  }
}

async function save() {
  if (!_stats) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushSave();
  }, SAVE_DEBOUNCE_MS);
}

async function flushNow() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  return flushSave();
}

async function getCfState() {
  const s = await load();
  return normalizeCfState(s.cfState);
}

async function setCfState(state) {
  const s = await load();
  s.cfState = normalizeCfState(state);
  await save();
}

async function getCfKeyLogs(index) {
  const s = await load();
  const logs = s.cfState.logs || {};
  return Array.isArray(logs[String(index)]) ? logs[String(index)] : [];
}

async function addCfKeyLog(index, entry) {
  const s = await load();
  const key = String(index);
  const logs = s.cfState.logs || {};
  const current = Array.isArray(logs[key]) ? logs[key] : [];
  current.unshift({ ...entry, timestamp: entry.timestamp || Date.now() });
  logs[key] = current.slice(0, CF_LOGS_PER_KEY);
  s.cfState.logs = logs;
  await save();
}

async function getExhaustedKeys() {
  const s = await load();
  return Array.from(s.keys.exhausted);
}

async function isKeyExhausted(index) {
  const s = await load();
  return s.keys.exhausted.has(index);
}

async function markKeyExhausted(index) {
  const s = await load();
  s.keys.exhausted.add(index);
  await save();
}

async function markKeyThrottled(index) {
  const s = await load();
  s.keys.throttled.add(index);
  await save();
}

async function unmarkKeyThrottled(index) {
  const s = await load();
  s.keys.throttled.delete(index);
  await save();
}

async function recordKeyError(index, error) {
  const s = await load();
  const key = `key_${index}`;
  const prev = s.keys.errors.get(key) || { count: 0, lastError: "", lastTime: 0 };
  s.keys.errors.set(key, {
    count: prev.count + 1,
    lastError: error,
    lastTime: Date.now(),
  });
  await save();
}

async function logRequest(data) {
  const s = await load();
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

  await save();
  return entry;
}

async function addLog(entry) {
  const s = await load();
  s.logs.unshift({ ...entry, id: s.logs.length + 1 });
  if (s.logs.length > MAX_LOGS) {
    s.logs = s.logs.slice(0, MAX_LOGS);
  }
  await save();
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

async function getStats(range) {
  const s = await load(true);
  const filtered = filterByRange(s.recentRequests, range);
  const filteredErrors = filterByRange(s.errors, range);

  let totalIn = 0;
  let totalOut = 0;
  let totalReqs = 0;
  let totalErrs = 0;
  let totalElapsed = 0;
  const providerStats = {};
  const modelStats = {};

  for (const r of filtered) {
    totalReqs++;
    totalIn += r.inputTokens || 0;
    totalOut += r.outputTokens || 0;
    totalElapsed += r.elapsed || 0;
    if (r.status >= 400) totalErrs++;

    const provider = r.provider || "kimchi";
    if (!providerStats[provider]) {
      providerStats[provider] = { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0, elapsed: 0 };
    }
    providerStats[provider].requests++;
    providerStats[provider].inputTokens += r.inputTokens || 0;
    providerStats[provider].outputTokens += r.outputTokens || 0;
    providerStats[provider].elapsed += r.elapsed || 0;
    if (r.status >= 400) providerStats[provider].errors++;

    const m = r.model || "unknown";
    if (!modelStats[m]) {
      modelStats[m] = { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0, elapsed: 0 };
    }
    modelStats[m].requests++;
    modelStats[m].inputTokens += r.inputTokens || 0;
    modelStats[m].outputTokens += r.outputTokens || 0;
    modelStats[m].elapsed += r.elapsed || 0;
    if (r.status >= 400) modelStats[m].errors++;
  }

  const avgElapsed = totalReqs > 0 ? Math.round(totalElapsed / totalReqs) : 0;
  for (const p of Object.values(providerStats)) {
    p.avgElapsed = p.requests > 0 ? Math.round(p.elapsed / p.requests) : 0;
  }
  for (const m of Object.values(modelStats)) {
    m.avgElapsed = m.requests > 0 ? Math.round(m.elapsed / m.requests) : 0;
  }

  const cost = (totalIn / 1000) * EST_COST_PER_1K_INPUT + (totalOut / 1000) * EST_COST_PER_1K_OUTPUT;

  const keysRaw = process.env.KIMCHI_API_KEYS || "";
  const totalKeys = keysRaw ? keysRaw.split(/[,\s]+/).filter(Boolean).length : 0;

  const keyErrors = {};
  for (const [k, v] of s.keys.errors) {
    keyErrors[k] = v;
  }

  return {
    range,
    totalRequests: totalReqs,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalErrors: totalErrs,
    estimatedCost: cost,
    avgElapsed,
    providers: providerStats,
    modelStats,
    keys: {
      total: totalKeys,
      active: totalKeys - s.keys.exhausted.size,
      exhausted: s.keys.exhausted.size,
      throttled: s.keys.throttled.size,
      _exhausted: Array.from(s.keys.exhausted),
      _throttled: Array.from(s.keys.throttled),
      errors: keyErrors,
    },
    recentRequests: filtered.slice(0, 50),
    errors: filteredErrors.slice(0, 50),
    logs: s.logs.slice(0, 50),
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
  getExhaustedKeys,
  isKeyExhausted,
  getCfState,
  setCfState,
  getCfKeyLogs,
  addCfKeyLog,
  flushNow,
};
