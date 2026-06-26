/**
 * Cloudflare Workers AI upstream proxy.
 * Uses OpenAI-compatible endpoint.
 */

const { requestUpstream, requestUpstreamStreaming, FETCH_TIMEOUT_MS } = require("./proxy.js");

const CF_UPSTREAM_BASE = "https://api.cloudflare.com/client/v4/accounts";

// In-memory rotation index for CF credentials
let cfCredentialIndex = 0;

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

async function isCfEnabled() {
  const enabled = process.env.CLOUDFLARE_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  if (parseCfCredentials().length === 0) return false;
  try {
    const { getSettings } = require("./settings.js");
    const settings = await getSettings();
    return settings.cf_enabled !== false;
  } catch (e) {
    console.error("[cloudflare] failed to read settings:", e.message);
    return true;
  }
}

function selectCfCredential() {
  const credentials = parseCfCredentials();
  if (credentials.length === 0) {
    throw new Error("No Cloudflare credentials configured");
  }
  const idx = cfCredentialIndex % credentials.length;
  cfCredentialIndex++;
  return { ...credentials[idx], index: idx, total: credentials.length };
}

function mapModelToCf(model) {
  const mapping = {
    "kimi-k2.7": "@cf/moonshotai/kimi-k2.7-code",
    "kimi-k2.6": "@cf/moonshotai/kimi-k2.6",
  };
  return mapping[model] || model;
}

function isSupportedModel(model) {
  return ["kimi-k2.7", "kimi-k2.6"].includes(model);
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

  const credential = selectCfCredential();
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

  let finishReason = null;
  try {
    const parsed = JSON.parse(result.body);
    finishReason = parsed.choices?.[0]?.finish_reason ?? null;
  } catch {}

  return {
    status: result.status,
    headers: result.headers,
    body: result.body,
    provider: "cf",
    cfIndex: credential.index,
    cfTotal: credential.total,
    attempts: 1,
    finishReason,
  };
}

async function proxyToCloudflareStreaming(options) {
  const {
    requestBody,
    requestHeaders = {},
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  const credential = selectCfCredential();
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

  return {
    status: result.status,
    headers: result.headers,
    stream: result.stream,
    provider: "cf",
    cfIndex: credential.index,
    cfTotal: credential.total,
    attempts: 1,
    finishReason: null,
  };
}

module.exports = {
  isCfEnabled,
  isSupportedModel,
  mapModelToCf,
  parseCfCredentials,
  proxyToCloudflare,
  proxyToCloudflareStreaming,
};
