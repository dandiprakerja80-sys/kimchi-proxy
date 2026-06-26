const fs = require("fs");

const STATS_FILE = "/tmp/kimchi-stats.json";
const BLOB_PATHNAME = "kimchi-proxy/stats.json";
const MAX_RECENT = 500;
const MAX_ERRORS = 500;
const MAX_LOGS = 500;
const EST_COST_PER_1K_INPUT = 0.0006;
const EST_COST_PER_1K_OUTPUT = 0.0024;
const REDIS_KEY = "kimchi-proxy:stats";

let _stats = null;
let _redis = null;

function getRedis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = require("@upstash/redis");
    _redis = new Redis({ url, token });
    return _redis;
  } catch (e) {
    console.error("[stats] failed to init redis:", e.message);
    return null;
  }
}

function getBlobClient() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { put, del } = require("@vercel/blob");
    return { put, del };
  } catch (e) {
    console.error("[stats] failed to init blob:", e.message);
    return null;
  }
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

function serialize(stats) {
  return {
    ...stats,
    keys: {
      exhausted: [...stats.keys.exhausted],
      throttled: [...stats.keys.throttled],
      errors: Object.fromEntries(stats.keys.errors),
    },
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
  };
}

async function loadFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = require("@vercel/blob");
    const { blobs } = await list({ prefix: BLOB_PATHNAME, limit: 1 });
    const blob = blobs.find((b) => b.pathname === BLOB_PATHNAME);
    if (!blob) return null;
    const res = await fetch(blob.url, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? deserialize(JSON.parse(text)) : null;
  } catch (e) {
    console.error("[stats] blob load failed:", e.message);
    return null;
  }
}

async function saveToBlob(payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { put } = require("@vercel/blob");
    await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
  } catch (e) {
    console.error("[stats] blob save failed:", e.message);
  }
}

async function load() {
  if (_stats) return _stats;

  const blobStats = await loadFromBlob();
  if (blobStats) {
    _stats = blobStats;
    return _stats;
  }

  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEY);
      if (raw) {
        _stats = deserialize(typeof raw === "string" ? JSON.parse(raw) : raw);
        return _stats;
      }
    } catch (e) {
      console.error("[stats] redis load failed:", e.message);
    }
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

async function save() {
  if (!_stats) return;
  const payload = serialize(_stats);

  await saveToBlob(payload);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(REDIS_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("[stats] redis save failed:", e.message);
    }
  }

  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(payload), "utf-8");
  } catch {}
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

  const provider = data.provider || "kimchi";

  const entry = {
    id: s.totalRequests,
    model: data.model || "unknown",
    provider,
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    keyIndex: data.keyIndex ?? 0,
    status: data.status || 200,
    elapsed: data.elapsed || 0,
    finishReason: data.finishReason || null,
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
      provider,
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

  const finishSegment = data.finishReason ? ` finish:${data.finishReason}` : "";
  s.logs.unshift({
    id: s.logs.length + 1,
    level: data.status >= 400 ? "error" : "info",
    message: `${data.model} (${provider}) in:${data.inputTokens || 0} out:${data.outputTokens || 0} ${data.elapsed}ms key:${data.keyIndex}${finishSegment} status:${data.status}${data.error ? " err:" + data.error : ""}`,
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
  const s = await load();
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
  const totalKeys = keysRaw ? keysRaw.split(/[\s,]+/).filter(Boolean).length : 0;

  const cfRaw = process.env.CLOUDFLARE_CREDENTIALS || "";
  const cfCreds = cfRaw ? cfRaw.split(/[\n;]+/).map(l => l.trim()).filter(l => l.includes(",")).length : 0;

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
    cloudflare: {
      credentials: cfCreds,
    },
    recentRequests: filtered.slice(0, 50),
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
