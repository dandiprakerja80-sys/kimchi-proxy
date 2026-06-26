const { URL } = require("url");
const { parseKeys, selectKey, isKeyThrottled } = require("../../lib/key-rotation.js");
const { proxyToKimchi, proxyToKimchiStreaming, writeResponse } = require("../../lib/proxy.js");
const { logRequest, getStats } = require("../../lib/stats.js");
const { validateProxyApiKey } = require("../../lib/auth.js");
const { isCfEnabled, isSupportedModel, proxyToCloudflare, proxyToCloudflareStreaming } = require("../../lib/cloudflare.js");

const KIMCHI_UPSTREAM = "https://llm.kimchi.dev/openai/v1/chat/completions";
const STREAM_TIMEOUT_MS = 120000;

const SKIP_HEADERS = new Set(["transfer-encoding", "connection", "content-length"]);

async function shouldUseCloudflare(model) {
  return (await isCfEnabled()) && isSupportedModel(model);
}

async function tryCloudflareThenKimchi({ body, getNextKey, requestHeaders, signal, maxRetries }) {
  if (await shouldUseCloudflare(body.model)) {
    try {
      const result = await proxyToCloudflare({
        requestBody: body,
        requestHeaders,
        signal,
      });
      if (result.status >= 200 && result.status < 300) {
        return { ...result, provider: "cf" };
      }
      console.log(`[cf] non-success status ${result.status}, falling back to kimchi`);
    } catch (err) {
      console.log(`[cf] error, falling back to kimchi: ${err.message}`);
    }
  }
  const result = await proxyToKimchi({
    upstreamUrl: KIMCHI_UPSTREAM,
    getNextKey,
    requestBody: body,
    requestHeaders,
    maxRetries,
    signal,
  });
  return { ...result, provider: "kimchi" };
}

async function tryCloudflareThenKimchiStreaming({ body, getNextKey, requestHeaders, signal }) {
  if (await shouldUseCloudflare(body.model)) {
    try {
      const result = await proxyToCloudflareStreaming({
        requestBody: body,
        requestHeaders,
        signal,
      });
      if (result.status >= 200 && result.status < 300) {
        return { ...result, provider: "cf" };
      }
      console.log(`[cf] non-success status ${result.status}, falling back to kimchi`);
    } catch (err) {
      console.log(`[cf] error, falling back to kimchi: ${err.message}`);
    }
  }
  const result = await proxyToKimchiStreaming({
    upstreamUrl: KIMCHI_UPSTREAM,
    getNextKey,
    requestBody: body,
    requestHeaders,
    signal,
  });
  return { ...result, provider: "kimchi" };
}

function setSseHeaders(res, extraHeaders = {}) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, String(value));
    }
  }
}

function streamPassthrough(clientRes, result) {
  return new Promise((resolve) => {
    const stream = result.stream;
    let done = false;
    let buffer = "";
    let finishReason = result.finishReason || "unknown";
    let outputTokens = 0;
    let lastDataTime = Date.now();

    const keepalive = setInterval(() => {
      if (!done && Date.now() - lastDataTime > 10000) {
        try { clientRes.write(": keepalive\n\n"); } catch {}
        lastDataTime = Date.now();
      }
    }, 5000);

    function finish(finalReason) {
      clearInterval(keepalive);
      done = true;
      if (!clientRes.writableEnded) {
        try { clientRes.end(); } catch {}
      }
      resolve({ finishReason: finalReason || finishReason, outputTokens });
    }

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
            finish("stop");
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const delta = choice?.delta || {};
            const content = delta.content || "";
            const reasoning = delta.reasoning_content || "";
            outputTokens += Math.ceil((content.length + reasoning.length) / 4);
          } catch {}
          try { clientRes.write(`data: ${data}\n\n`); } catch {}
        } else if (line.startsWith(":")) {
          // SSE comment, skip
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        if (buffer.startsWith("data: ")) {
          const data = buffer.slice(6);
          if (data === "[DONE]") {
            finish("stop");
            return;
          }
          try { clientRes.write(`data: ${data}\n\n`); } catch {}
        }
      }
      finish(finishReason);
    });

    stream.on("error", () => finish("error"));
    stream.on("close", () => finish(finishReason));
  });
}

function extractFinishReasonFromBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return parsed.choices?.[0]?.finish_reason ?? "unknown";
  } catch {
    return "unknown";
  }
}

function extractUsageFromBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return {
      inputTokens: parsed.usage?.prompt_tokens || 0,
      outputTokens: parsed.usage?.completion_tokens || 0,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

module.exports = async function handler(req, res) {
  if (!validateProxyApiKey(req, res)) {
    return;
  }

  if (req.method === "GET" && req.url && req.url.includes("action=stats")) {
    const url = new URL(req.url, "http://localhost");
    const range = url.searchParams.get("range") || "today";
    const stats = await getStats(range);
    return res.status(200).json(stats);
  }

  const keysRaw = process.env.KIMCHI_API_KEYS;
  const keys = parseKeys(keysRaw);
  let startTime = 0;
  let lastKeyIndex = 0;
  let model = "unknown";

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (keys.length === 0) {
      return res.status(500).json({ error: "No API keys configured. Set KIMCHI_API_KEYS env var." });
    }

    const keyIndexHeader = req.headers["x-kimchi-key-index"];
    let preferredIndex = undefined;
    if (keyIndexHeader && typeof keyIndexHeader === "string") {
      preferredIndex = parseInt(keyIndexHeader, 10);
    }

    let keySelection;
    try {
      keySelection = selectKey({ keys }, preferredIndex);
    } catch (e) {
      return res.status(500).json({ error: "Failed to select API key" });
    }

    let rotateIndex = keySelection.index;

    const getNextKey = () => {
      let skipAttempts = 0;
      while (isKeyThrottled(keys[rotateIndex]) && skipAttempts < keys.length) {
        rotateIndex = (rotateIndex + 1) % keys.length;
        skipAttempts++;
      }
      const key = keys[rotateIndex];
      const idx = rotateIndex;
      rotateIndex = (rotateIndex + 1) % keys.length;
      lastKeyIndex = idx;
      return { key, index: idx };
    };

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    model = body.model || "unknown";
    startTime = Date.now();
    const isStreaming = body.stream === true;

    if (isStreaming) {
      const streamBody = { ...body };
      if (!streamBody.stream_options) {
        streamBody.stream_options = { include_usage: true };
      }

      const result = await tryCloudflareThenKimchiStreaming({
        body: streamBody,
        getNextKey,
        requestHeaders: { "X-Request-Start": String(Date.now()) },
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      });

      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(result.attempts));
      res.setHeader("X-Proxy-Provider", result.provider || "kimchi");
      setSseHeaders(res, result.headers);
      res.status(result.status);

      const streamStartTime = startTime;
      const streamResult = await streamPassthrough(res, result);
      const elapsed = Date.now() - streamStartTime;

      await logRequest({
        model,
        status: result.status,
        elapsed,
        keyIndex: lastKeyIndex,
        provider: result.provider || "kimchi",
        inputTokens: body.messages ? body.messages.reduce((s, m) => s + (m.content || "").length / 4, 0) : 0,
        outputTokens: streamResult.outputTokens || 0,
        finishReason: streamResult.finishReason || result.finishReason || "unknown",
        method: "POST",
      });
    } else {
      const result = await tryCloudflareThenKimchi({
        body,
        getNextKey,
        requestHeaders: { "X-Request-Start": String(Date.now()) },
        maxRetries: Math.min(keys.length, 55),
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      });

      const finishReason = extractFinishReasonFromBody(result.body);
      const { inputTokens, outputTokens } = extractUsageFromBody(result.body);
      const elapsed = Date.now() - startTime;

      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(result.attempts));
      res.setHeader("X-Proxy-Elapsed-Ms", String(elapsed));
      res.setHeader("X-Proxy-Provider", result.provider || "kimchi");
      res.setHeader("X-Proxy-Finish-Reason", String(finishReason));

      await logRequest({
        model,
        status: result.status,
        elapsed,
        keyIndex: lastKeyIndex,
        provider: result.provider || "kimchi",
        inputTokens,
        outputTokens,
        finishReason,
        method: "POST",
      });

      writeResponse(res, result);
    }
  } catch (error) {
    console.error("[completions proxy] error:", error);
    const elapsed = startTime ? Date.now() - startTime : 0;
    const err = error instanceof Error ? error : new Error(String(error));

    await logRequest({
      model,
      status: 502,
      elapsed,
      keyIndex: lastKeyIndex,
      inputTokens: 0,
      outputTokens: 0,
      method: "POST",
      error: err.message,
      details: err.stack,
    });

    return res.status(502).json({
      ok: false,
      error: "Failed to reach upstream API",
      keyIndex: lastKeyIndex,
      keyTotal: keys.length,
      attempts: 0,
      elapsedMs: elapsed,
      details: err.message,
    });
  }
};
