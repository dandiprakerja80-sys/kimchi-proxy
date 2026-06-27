/**
 * Cloudflare Workers AI upstream proxy.
 * Uses OpenAI-compatible endpoint.
 */

const { requestUpstream, requestUpstreamStreaming, FETCH_TIMEOUT_MS } = require("./proxy.js");

const CF_UPSTREAM_BASE = "https://api.cloudflare.com/client/v4/accounts";

// In-memory rotation index for CF credentials
let cfCredentialIndex = 0;

// Map: credential index -> timestamp (ms) until which it is blacklisted
const exhaustedUntil = new Map();

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

function isCredentialExhausted(index) {
  const until = exhaustedUntil.get(index);
  if (!until) return false;
  if (Date.now() >= until) {
    exhaustedUntil.delete(index);
    return false;
  }
  return true;
}

function markCredentialExhausted(index) {
  exhaustedUntil.set(index, getNextUtcMidnight());
}

function hasUsableCredential() {
  const credentials = parseCfCredentials();
  for (let i = 0; i < credentials.length; i++) {
    if (!isCredentialExhausted(i)) return true;
  }
  return false;
}

function isCfEnabled() {
  const enabled = process.env.CLOUDFLARE_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  const creds = parseCfCredentials();
  const usable = hasUsableCredential();
  console.log(`[cf debug] env=${enabled}, creds=${creds.length}, usable=${usable}`);
  return creds.length > 0 && usable;
}

function selectCfCredential() {
  const credentials = parseCfCredentials();
  if (credentials.length === 0) {
    throw new Error("No Cloudflare credentials configured");
  }

  const startIdx = cfCredentialIndex % credentials.length;
  for (let i = 0; i < credentials.length; i++) {
    const idx = (startIdx + i) % credentials.length;
    if (!isCredentialExhausted(idx)) {
      cfCredentialIndex = idx + 1;
      return { ...credentials[idx], index: idx, total: credentials.length };
    }
  }

  throw new Error("All Cloudflare credentials exhausted");
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
  if (status !== 429) return false;
  if (!bodyText || typeof bodyText !== "string") return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("daily free allocation") || lower.includes("used up your daily");
}

function buildCfUpstreamUrl(accountId) {
  return `${CF_UPSTREAM_BASE}/${accountId}/ai/v1/chat/completions`;
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
      credential = selectCfCredential();
    } catch (err) {
      if (err.message === "All Cloudflare credentials exhausted") break;
      throw err;
    }

    attempts++;
    const upstreamUrl = buildCfUpstreamUrl(credential.accountId);
    const cfBody = { ...requestBody, model: mapModelToCf(requestBody.model) };

    const result = await requestUpstream({
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

    if (isQuotaError(result.status, result.body)) {
      console.log(`[cf] credential #${credential.index} hit daily quota, blacklisting until UTC reset`);
      markCredentialExhausted(credential.index);
      continue;
    }

    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
      provider: "cf",
      cfIndex: credential.index,
      cfTotal: credential.total,
      attempts,
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
      credential = selectCfCredential();
    } catch (err) {
      if (err.message === "All Cloudflare credentials exhausted") break;
      throw err;
    }

    attempts++;
    const upstreamUrl = buildCfUpstreamUrl(credential.accountId);
    const cfBody = { ...requestBody, model: mapModelToCf(requestBody.model) };

    const result = await requestUpstreamStreaming({
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

    if (result.status === 429) {
      // For streaming we cannot read the body synchronously to detect quota message,
      // so we must consume the stream first. If the status is already 429, CF usually
      // returns a JSON error body, not a stream. We read the first chunk to inspect.
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
        markCredentialExhausted(credential.index);
        continue;
      }

      // Not a quota error; we already consumed part of the stream so just return what we have.
      return {
        status: result.status,
        headers: result.headers,
        stream: result.stream,
        provider: "cf",
        cfIndex: credential.index,
        cfTotal: credential.total,
        attempts,
      };
    }

    return {
      status: result.status,
      headers: result.headers,
      stream: result.stream,
      provider: "cf",
      cfIndex: credential.index,
      cfTotal: credential.total,
      attempts,
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
};
