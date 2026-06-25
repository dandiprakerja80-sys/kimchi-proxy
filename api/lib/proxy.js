const https = require("https");
const http = require("http");
const { URL } = require("url");
const { markKeyExhausted, recordKeyError } = require("./stats.js");

const RETRYABLE_STATUSES = new Set([402, 429, 500, 502, 503, 504, 524]);
const DEFAULT_MAX_RETRIES = 55;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;
const BACKOFF_FACTOR = 1.5;
const FETCH_TIMEOUT_MS = 120000;
const AUTO_CONTINUE_MAX = 3;
const KEEPALIVE_INTERVAL_MS = 10000;

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

function requestUpstreamStreaming(options) {
  return new Promise((resolve, reject) => {
    const { url, method, headers, body, signal } = options;
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
      },
      (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          stream: res,
        });
      },
    );

    req.on("error", reject);

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
        markKeyExhausted(currentIndex);
        recordKeyError(currentIndex, `HTTP ${result.status}: credits exhausted`);
        lastError.push(new Error(`HTTP ${result.status}: credits exhausted (key ${currentIndex})`));
        continue;
      }

      recordKeyError(currentIndex, `HTTP ${result.status}`);
      lastError.push(new Error(`HTTP ${result.status} (key ${currentIndex})`));

      if (result.status === 429) {
        const retryAfterMs = parseRetryAfterMs(result.headers);
        const delay = retryAfterMs !== null ? Math.max(computeDelay(attempt), retryAfterMs) : computeDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      recordKeyError(currentIndex, error.message);
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

async function proxyToKimchiStreaming(options) {
  const {
    upstreamUrl,
    getNextKey,
    requestHeaders = {},
    requestBody,
    method = "POST",
    timeoutMs = FETCH_TIMEOUT_MS,
    signal,
  } = options;

  let lastError = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const keyInfo = getNextKey();

    try {
      const result = await requestUpstreamStreaming({
        url: upstreamUrl,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyInfo.key}`,
          ...KIMCHI_CLI_HEADERS,
          ...requestHeaders,
          "X-Proxy-Key-Index": String(keyInfo.index),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal,
      });

      return {
        status: result.status,
        headers: result.headers,
        stream: result.stream,
        keyIndex: keyInfo.index,
        attempts: attempt,
      };
    } catch (error) {
      lastError.push(error instanceof Error ? error : new Error(String(error)));
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  throw new Error(`Streaming proxy failed: ${lastError.map((e) => e.message).join("; ")}`);
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

function streamResponse(clientRes, result, options = {}) {
  const skipHeaders = new Set(["transfer-encoding", "connection", "content-length"]);
  for (const [key, value] of Object.entries(result.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) {
      clientRes.setHeader(key, String(value));
    }
  }

  clientRes.setHeader("Content-Type", "text/event-stream");
  clientRes.setHeader("Cache-Control", "no-cache");
  clientRes.setHeader("Connection", "keepalive");
  clientRes.setHeader("X-Accel-Buffering", "no");
  clientRes.status(result.status);

  const stream = result.stream;
  let done = false;
  let lastDataTime = Date.now();
  let buffer = "";
  let hasContent = false;
  let hasReasoning = false;

  const keepalive = setInterval(() => {
    if (!done && Date.now() - lastDataTime > KEEPALIVE_INTERVAL_MS) {
      try {
        clientRes.write(": keepalive\n\n");
        lastDataTime = Date.now();
      } catch {}
    }
  }, 5000);

  stream.on("data", (chunk) => {
    lastDataTime = Date.now();
    const text = chunk.toString("utf-8");
    buffer += text;

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") {
          done = true;
          try {
            clientRes.write(`data: [DONE]\n\n`);
          } catch {}
        } else {
          try {
            const parsed = JSON.parse(data);
            if (parsed.choices && parsed.choices[0]) {
              const delta = parsed.choices[0].delta;
              if (delta && delta.reasoning_content !== undefined) {
                hasReasoning = true;
              }
              if (delta && delta.content !== undefined) {
                hasContent = true;
              }
            }
          } catch {}
          try {
            clientRes.write(`data: ${data}\n\n`);
          } catch {}
        }
      } else if (line.trim() === "") {
        // empty line, ignore
      } else if (line.startsWith(":")) {
        // SSE comment, ignore
      }
    }
  });

  stream.on("end", () => {
    clearInterval(keepalive);
    done = true;
    if (!clientRes.writableEnded) {
      try {
        clientRes.end();
      } catch {}
    }
  });

  stream.on("error", (err) => {
    clearInterval(keepalive);
    if (!clientRes.writableEnded) {
      try {
        clientRes.end();
      } catch {}
    }
  });

  stream.on("close", () => {
    clearInterval(keepalive);
    if (!clientRes.writableEnded) {
      try {
        clientRes.end();
      } catch {}
    }
  });
}

module.exports = { proxyToKimchi, proxyToKimchiStreaming, writeResponse, streamResponse, KIMCHI_CLI_HEADERS };
