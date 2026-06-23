const RETRYABLE_STATUSES = new Set([402, 429, 500, 502, 503, 504, 524]);
const DEFAULT_MAX_RETRIES = 55;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;
const BACKOFF_FACTOR = 1.5;
const FETCH_TIMEOUT_MS = 10000;

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

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let finalSignal = ctrl.signal;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new Error(`Proxy aborted after ${attempt - 1} attempts`);
      }
      signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }

    try {
      const response = await fetch(upstreamUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentKey}`,
          ...KIMCHI_CLI_HEADERS,
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
        continue;
      }

      lastError.push(new Error(`HTTP ${response.status} (key ${currentIndex})`));

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response);
        const delay = retryAfterMs !== null ? Math.max(computeDelay(attempt), retryAfterMs) : computeDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      clearTimeout(timer);

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
