const RETRYABLE_STATUSES = new Set([402, 429, 500, 502, 503, 504, 524]);
const DEFAULT_MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;
const BACKOFF_FACTOR = 2;
const FETCH_TIMEOUT_MS = 20000;

function computeDelay(attempt, random = Math.random) {
  const planned = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1), MAX_DELAY_MS);
  return Math.max(planned * random(), 100);
}

function parseRetryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), 0);
  return null;
}

function isCreditExhausted(response, body) {
  if (response.status !== 402 && response.status !== 429) return false;
  try {
    const text = typeof body === "string" ? body : "";
    return text.includes("exhausted") || text.includes("credit") || text.includes("quota");
  } catch {
    return false;
  }
}

async function proxyToKimchi(options) {
  const {
    upstreamUrl,
    getNextKey,
    requestHeaders = {},
    requestBody,
    method = "POST",
    retry = {},
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  const maxRetries = retry.maxRetries ?? DEFAULT_MAX_RETRIES;
  const lastError = [];
  let currentKey = null;
  let currentIndex = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const keyInfo = getNextKey();
    currentKey = keyInfo.key;
    currentIndex = keyInfo.index;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const finalSignal = signal
      ? typeof AbortSignal.any === "function"
        ? AbortSignal.any([ctrl.signal, signal])
        : ctrl.signal
      : ctrl.signal;

    try {
      const response = await fetch(upstreamUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentKey}`,
          "User-Agent": "kimchi-proxy/1.0.0",
          ...requestHeaders,
          "X-Proxy-Key-Index": String(currentIndex),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: finalSignal,
      });

      clearTimeout(timer);

      if (!RETRYABLE_STATUSES.has(response.status)) {
        return { response, keyIndex: currentIndex, attempts: attempt };
      }

      const responseText = await response.text().catch(() => "");

      if (isCreditExhausted(response, responseText)) {
        lastError.push(new Error(`HTTP ${response.status}: credits exhausted (key ${currentIndex})`));
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
      }

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    clientRes.write(value);
  }
  clientRes.end();
}

module.exports = { proxyToKimchi, streamResponse };
