/**
 * Shared proxy logic for Kimchi API.
 * Handles request forwarding, retry logic, and streaming.
 */

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 524]);
const DEFAULT_MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;
const BACKOFF_FACTOR = 2;
const FETCH_TIMEOUT_MS = 20000;

/**
 * Compute retry delay with exponential backoff and full jitter.
 */
function computeDelay(attempt, random = Math.random) {
  const planned = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1), MAX_DELAY_MS);
  return Math.max(planned * random(), 100);
}

/**
 * Parse Retry-After header.
 */
function parseRetryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), 0);
  return null;
}

/**
 * Proxy a request to Kimchi API with retry logic.
 */
async function proxyToKimchi(options) {
  const {
    upstreamUrl,
    apiKey,
    requestHeaders = {},
    requestBody,
    method = "POST",
    retry = {},
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  const maxRetries = retry.maxRetries ?? DEFAULT_MAX_RETRIES;
  const lastError = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const finalSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;

    try {
      const response = await fetch(upstreamUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "kimchi-proxy/1.0.0",
          ...requestHeaders,
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: finalSignal,
      });

      clearTimeout(timer);

      if (!RETRYABLE_STATUSES.has(response.status)) {
        return { response, keyIndex: 0, attempts };
      }

      await response.body?.cancel().catch(() => {});

      lastError.push(new Error(`HTTP ${response.status}`));

      const retryAfterMs = parseRetryAfterMs(response);
      const delay = retryAfterMs !== null ? Math.max(computeDelay(attempt), retryAfterMs) : computeDelay(attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      clearTimeout(timer);
      if (signal?.aborted) throw error;

      lastError.push(error instanceof Error ? error : new Error(String(error)));

      if (attempt === maxRetries) {
        throw new Error(
          `Proxy failed after ${maxRetries} attempts: ${lastError.map((e) => e.message).join("; ")}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, computeDelay(attempt)));
    }
  }

  throw new Error("Proxy retry loop exhausted");
}

/**
 * Stream upstream response to client.
 */
async function streamResponse(clientRes, upstreamRes) {
  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    clientRes.status(upstreamRes.status).end();
    return;
  }

  clientRes.setHeader("Content-Type", upstreamRes.headers.get("content-type") || "text/event-stream");
  clientRes.setHeader("Cache-Control", "no-cache");
  clientRes.setHeader("Connection", "keep-alive");

  for (const [key, value] of upstreamRes.headers.entries()) {
    if (!["transfer-encoding", "connection", "content-length"].includes(key.toLowerCase())) {
      clientRes.setHeader(key, value);
    }
  }

  clientRes.status(upstreamRes.status);

  // For Vercel serverless, we need to write chunks directly
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    clientRes.write(value);
  }
  clientRes.end();
}

module.exports = { proxyToKimchi, streamResponse };
