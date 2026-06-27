/**
 * Cloudflare Workers AI upstream proxy.
 * Uses OpenAI-compatible endpoint.
 */

const { requestUpstream, requestUpstreamStreaming, FETCH_TIMEOUT_MS } = require("./proxy.js");
const { getCfState, setCfState, addCfKeyLog } = require("./stats.js");

const CF_UPSTREAM_BASE = "https://api.cloudflare.com/client/v4/accounts";
const SLOW_THRESHOLD_MS = 20 * 1000;
const THROTTLE_DURATION_MS = 30 * 60 * 1000;

function parseCfCredentials() {
  const raw = process.env.CLOUDFLARE_CREDENTIALS;
  if (!raw || !raw.trim()) return [];

  return raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(",");
      if (idx === -1) return null;
      const accountId = line.slice(0, idx).trim();
      const token = line.slice(idx + 1).trim();
      if (!accountId || !token) return null;
      return { accountId, token };
    })
    .filter(Boolean);
}

function getNextUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime();
}

async function getCfStateSafe() {
  try {
    return await getCfState();
  } catch (e) {
    console.error("[cf] failed to load state:", e.message);
    return { nextIndex: 0, exhausted: [], throttled: [], slow: [], logs: {} };
  }
}

function cleanupExpired(state) {
  const now = Date.now();
  state.exhausted = state.exhausted.filter((e) => now < e.until);
  state.throttled = state.throttled.filter((e) => now < e.until);
  state.slow = state.slow.filter((e) => now < e.until);
}

function isCredentialBlocked(state, index) {
  const now = Date.now();
  return (
    state.exhausted.some((e) => e.index === index && now < e.until) ||
    state.throttled.some((e) => e.index === index && now < e.until) ||
    state.slow.some((e) => e.index === index && now < e.until)
  );
}

async function updateCfState(mutator) {
  const state = await getCfStateSafe();
  cleanupExpired(state);
  mutator(state);
  try {
    await setCfState(state);
  } catch (e) {
    console.error("[cf] failed to save state:", e.message);
  }
}

async function markCredentialExhausted(index) {
  await updateCfState((state) => {
    if (!state.exhausted.some((e) => e.index === index)) {
      state.exhausted.push({ index, until: getNextUtcMidnight() });
    }
  });
}

async function markCredentialThrottled(index) {
  await updateCfState((state) => {
    if (!state.throttled.some((e) => e.index === index)) {
      state.throttled.push({ index, until: Date.now() + THROTTLE_DURATION_MS });
    }
  });
}

async function markCredentialSlow(index) {
  await updateCfState((state) => {
    if (!state.slow.some((e) => e.index === index)) {
      state.slow.push({ index, until: Date.now() + THROTTLE_DURATION_MS });
    }
  });
}

async function addCredentialLog(index, data) {
  try {
    await addCfKeyLog(index, data);
  } catch (e) {
    console.error("[cf] failed to save credential log:", e.message);
  }
}

async function hasUsableCredential() {
  const credentials = parseCfCredentials();
  const state = await getCfStateSafe();
  cleanupExpired(state);
  for (let i = 0; i < credentials.length; i++) {
    if (!isCredentialBlocked(state, i)) return true;
  }
  return false;
}

function isCfEnabled() {
  const enabled = process.env.CLOUDFLARE_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return parseCfCredentials().length > 0;
}

async function getCfStatus() {
  const credentials = parseCfCredentials();
  const state = await getCfStateSafe();
  cleanupExpired(state);
  const total = credentials.length;
  const blocked = new Set();
  for (const tier of [state.exhausted, state.throttled, state.slow]) {
    for (const e of tier) blocked.add(e.index);
  }
  const activeCount = total - blocked.size;
  const allBlocked = [...state.exhausted, ...state.throttled, ...state.slow];
  const nextReset = allBlocked.length > 0 ? Math.min(...allBlocked.map((e) => e.until)) : null;
  return {
    enabled: isCfEnabled() && activeCount > 0,
    total,
    active: Math.max(0, activeCount),
    exhausted: state.exhausted.length,
    throttled: state.throttled.length,
    slow: state.slow.length,
    blockedCredentials: {
      exhausted: state.exhausted,
      throttled: state.throttled,
      slow: state.slow,
    },
    nextReset,
  };
}

async function selectCfCredential() {
  const credentials = parseCfCredentials();
  if (credentials.length === 0) {
    throw new Error("No Cloudflare credentials configured");
  }

  const state = await getCfStateSafe();
  cleanupExpired(state);

  let startIdx = state.nextIndex % credentials.length;
  let selectedIdx = -1;
  for (let i = 0; i < credentials.length; i++) {
    const idx = (startIdx + i) % credentials.length;
    if (!isCredentialBlocked(state, idx)) {
      selectedIdx = idx;
      break;
    }
  }

  if (selectedIdx === -1) {
    throw new Error("All Cloudflare credentials exhausted");
  }

  state.nextIndex = (selectedIdx + 1) % credentials.length;
  try {
    await setCfState(state);
  } catch (e) {
    console.error("[cf] failed to save rotation state:", e.message);
  }

  return { ...credentials[selectedIdx], index: selectedIdx, total: credentials.length };
}

function mapModelToCf(model) {
  const mapping = {
    "kimi-k2.7": "@cf/zai-org/glm-5.2",
  };
  return mapping[model] || model;
}

function isSupportedModel(model) {
  return model === "kimi-k2.7";
}

function requestContainsImages(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "image_url" || item.type === "image") {
          return true;
        }
      }
    }
  }
  return false;
}

function isQuotaError(status, bodyText) {
  if (status !== 429 && status !== 402) return false;
  if (!bodyText || typeof bodyText !== "string") return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("daily free allocation") ||
    lower.includes("used up your daily") ||
    lower.includes("exhausted") ||
    lower.includes("credit") ||
    lower.includes("quota")
  );
}

function isRateLimitError(status) {
  return status === 429;
}

function buildCfUpstreamUrl(accountId) {
  return `${CF_UPSTREAM_BASE}/${accountId}/ai/v1/chat/completions`;
}

function estimateOutputTokens(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.usage && typeof parsed.usage.completion_tokens === "number") {
      return parsed.usage.completion_tokens;
    }
    const content = parsed.choices?.[0]?.message?.content || "";
    return Math.ceil(content.length / 4);
  } catch {
    return 0;
  }
}

function estimateInputTokens(requestBody) {
  const messages = requestBody?.messages;
  if (!Array.isArray(messages)) return 0;
  return Math.ceil(messages.reduce((s, m) => s + (m.content || "").length / 4, 0));
}

async function proxyToCloudflare(options) {
  const {
    requestBody,
    requestHeaders = {},
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  let attempts = 0;
  while (true) {
    let credential;
    try {
      credential = await selectCfCredential();
    } catch (err) {
      if (err.message === "All Cloudflare credentials exhausted") break;
      throw err;
    }

    attempts++;
    const upstreamUrl = buildCfUpstreamUrl(credential.accountId);
    const cfBody = { ...requestBody, model: mapModelToCf(requestBody.model) };

    const startTime = Date.now();
    const inputTokens = estimateInputTokens(requestBody);
    let result;
    try {
      result = await requestUpstream({
        url: upstreamUrl,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.token}`,
          ...requestHeaders,
          "X-Proxy-Cf-Index": String(credential.index),
        },
        body: JSON.stringify(cfBody),
        timeoutMs,
        signal,
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      await addCredentialLog(credential.index, {
        status: 0,
        elapsed,
        inputTokens,
        outputTokens: 0,
        error: err.message || "network error",
      });
      throw err;
    }

    const elapsed = Date.now() - startTime;
    const outputTokens = estimateOutputTokens(result.body);

    if (isQuotaError(result.status, result.body)) {
      console.log(`[cf] credential #${credential.index} hit daily quota, blacklisting until UTC reset`);
      await markCredentialExhausted(credential.index);
      await addCredentialLog(credential.index, {
        status: result.status,
        elapsed,
        inputTokens,
        outputTokens,
        error: "daily quota exhausted",
      });
      continue;
    }

    if (isRateLimitError(result.status)) {
      console.log(`[cf] credential #${credential.index} hit rate limit, throttling for ${THROTTLE_DURATION_MS / 60000}m`);
      await markCredentialThrottled(credential.index);
      await addCredentialLog(credential.index, {
        status: result.status,
        elapsed,
        inputTokens,
        outputTokens,
        error: "rate limited",
      });
      continue;
    }

    const slow = elapsed > SLOW_THRESHOLD_MS;
    if (slow) {
      console.log(`[cf] credential #${credential.index} slow (${elapsed}ms), marking slow for ${THROTTLE_DURATION_MS / 60000}m`);
      await markCredentialSlow(credential.index);
    }

    await addCredentialLog(credential.index, {
      status: result.status,
      elapsed,
      inputTokens,
      outputTokens,
      error: null,
    });

    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
      provider: "cf",
      cfIndex: credential.index,
      cfTotal: credential.total,
      attempts,
      elapsed,
    };
  }

  throw new Error("All Cloudflare credentials exhausted");
}

async function proxyToCloudflareStreaming(options) {
  const {
    requestBody,
    requestHeaders = {},
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  let attempts = 0;
  while (true) {
    let credential;
    try {
      credential = await selectCfCredential();
    } catch (err) {
      if (err.message === "All Cloudflare credentials exhausted") break;
      throw err;
    }

    attempts++;
    const upstreamUrl = buildCfUpstreamUrl(credential.accountId);
    const cfBody = { ...requestBody, model: mapModelToCf(requestBody.model) };

    const startTime = Date.now();
    const inputTokens = estimateInputTokens(requestBody);
    let result;
    try {
      result = await requestUpstreamStreaming({
        url: upstreamUrl,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.token}`,
          ...requestHeaders,
          "X-Proxy-Cf-Index": String(credential.index),
        },
        body: JSON.stringify(cfBody),
        timeoutMs,
        signal,
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      await addCredentialLog(credential.index, {
        status: 0,
        elapsed,
        inputTokens,
        outputTokens: 0,
        error: err.message || "network error",
      });
      throw err;
    }

    const elapsed = Date.now() - startTime;

    if (result.status === 429) {
      const chunks = [];
      let resolved = false;
      const bodyText = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve("");
          }
        }, 2000);
        result.stream.on("data", (chunk) => {
          chunks.push(chunk.toString("utf-8"));
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(chunks.join(""));
          }
        });
        result.stream.on("end", () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(chunks.join(""));
          }
        });
        result.stream.on("error", () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve("");
          }
        });
      });

      if (isQuotaError(result.status, bodyText)) {
        console.log(`[cf] credential #${credential.index} hit daily quota (streaming), blacklisting until UTC reset`);
        await markCredentialExhausted(credential.index);
      } else {
        console.log(`[cf] credential #${credential.index} hit rate limit (streaming), throttling for ${THROTTLE_DURATION_MS / 60000}m`);
        await markCredentialThrottled(credential.index);
      }

      await addCredentialLog(credential.index, {
        status: result.status,
        elapsed,
        inputTokens,
        outputTokens: 0,
        error: isQuotaError(result.status, bodyText) ? "daily quota exhausted" : "rate limited",
      });
      continue;
    }

    const slow = elapsed > SLOW_THRESHOLD_MS;
    if (slow) {
      console.log(`[cf] credential #${credential.index} slow first byte (${elapsed}ms), marking slow for ${THROTTLE_DURATION_MS / 60000}m`);
      await markCredentialSlow(credential.index);
    }

    await addCredentialLog(credential.index, {
      status: result.status,
      elapsed,
      inputTokens,
      outputTokens: 0,
      error: null,
    });

    return {
      status: result.status,
      headers: result.headers,
      stream: result.stream,
      provider: "cf",
      cfIndex: credential.index,
      cfTotal: credential.total,
      attempts,
      elapsed,
    };
  }

  throw new Error("All Cloudflare credentials exhausted");
}

module.exports = {
  isCfEnabled,
  isSupportedModel,
  mapModelToCf,
  parseCfCredentials,
  proxyToCloudflare,
  proxyToCloudflareStreaming,
  requestContainsImages,
  getCfStatus,
};
