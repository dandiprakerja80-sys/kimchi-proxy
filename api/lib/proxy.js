const https = require("https");
const http = require("http");
const { URL } = require("url");

const RETRYABLE_STATUSES = new Set([402, 429, 500, 502, 503, 504, 524]);
const DEFAULT_MAX_RETRIES = 55;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;
const BACKOFF_FACTOR = 1.5;
const FETCH_TIMEOUT_MS = 15000;

const KIMCHI_CLI_HEADERS = {
  "User-Agent": "kimchi/0.1.34",
  "Accept": "application/json",
  "X-Stainless-Lang": "js",
  "X-Stainless-Package-Version": "5.20.0",
  "X-Stainless-OS": "linux",
  "X-Stainless-Arch": "x64",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Runtime-Version": "v22.0.0",
};

function computeDelay(attempt, random = Math.random) {
  const planned = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1), MAX_DELAY_MS);
  return Math.max(planned * random(), 50);
}

function parseRetryAfterMs(headers) {
  const header = headers["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), 0);
  return null;
}

function isCreditExhausted(status, body) {
  if (status !== 402 && status !== 429) return false;
  try {
    return body.includes("exhausted") || body.includes("credit") || body.includes("quota");
  } catch {
    return false;
  }
}

function requestUpstream(options) {
  return new Promise((resolve, reject) => {
    const { url, method, headers, body, timeoutMs, signal } = options;
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const reqHeaders = { ...headers, "Content-Length": Buffer.byteLength(body || "") };

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new Error("Request aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          reject(new Error("Request aborted"));
        },
        { once: true },
      );
    }

    if (body) req.write(body);
    req.end();
  });
}

async function proxyToKimchi(options) {
  const {
    upstreamUrl,
    getNextKey,
    requestHeaders = {},
    requestBody,
    method = "POST",
    maxRetries: maxRetriesParam,
    retry = {},
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  const maxRetries = maxRetriesParam ?? retry.maxRetries ?? DEFAULT_MAX_RETRIES;
  const lastError = [];
  let currentKey = null;
  let currentIndex = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error(`Proxy aborted after ${attempt - 1} attempts`);
    }

    const keyInfo = getNextKey();
    currentKey = keyInfo.key;
    currentIndex = keyInfo.index;

    try {
      const result = await requestUpstream({
        url: upstreamUrl,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentKey}`,
          ...KIMCHI_CLI_HEADERS,
          ...requestHeaders,
          "X-Proxy-Key-Index": String(currentIndex),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        timeoutMs,
        signal,
      });

      if (!RETRYABLE_STATUSES.has(result.status)) {
        return {
          status: result.status,
          headers: result.headers,
          body: result.body,
          keyIndex: currentIndex,
          attempts: attempt,
        };
      }

      if (isCreditExhausted(result.status, result.body)) {
        lastError.push(new Error(`HTTP ${result.status}: credits exhausted (key ${currentIndex})`));
        continue;
      }

      lastError.push(new Error(`HTTP ${result.status} (key ${currentIndex})`));

      if (result.status === 429) {
        const retryAfterMs = parseRetryAfterMs(result.headers);
        const delay = retryAfterMs !== null ? Math.max(computeDelay(attempt), retryAfterMs) : computeDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError.push(error instanceof Error ? error : new Error(String(error)));

      if (attempt === maxRetries) {
        throw new Error(
          `Proxy failed after ${maxRetries} attempts: ${lastError.slice(-3).map((e) => e.message).join("; ")}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, computeDelay(attempt)));
    }
  }

  throw new Error("Proxy retry loop exhausted");
}

function writeResponse(clientRes, result) {
  const skipHeaders = new Set(["transfer-encoding", "connection", "content-length"]);
  for (const [key, value] of Object.entries(result.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) {
      clientRes.setHeader(key, String(value));
    }
  }

  const body = result.body || "";
  clientRes.setHeader("Content-Length", Buffer.byteLength(body));
  clientRes.status(result.status);
  clientRes.end(body);
}

module.exports = { proxyToKimchi, writeResponse };
