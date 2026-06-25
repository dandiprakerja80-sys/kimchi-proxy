const https = require("https");
const http = require("http");
const { URL } = require("url");
const { parseKeys, selectKey, throttleKey, isKeyThrottled } = require("../../lib/key-rotation.js");
const { proxyToKimchi, proxyToKimchiStreaming, writeResponse } = require("../../lib/proxy.js");
const { logRequest, getStats } = require("../../lib/stats.js");
const { KIMCHI_CLI_HEADERS } = require("../../lib/proxy.js");
const { validateProxyApiKey } = require("../../lib/auth.js");

const KIMCHI_UPSTREAM = "https://llm.kimchi.dev/openai/v1/chat/completions";
const AUTO_CONTINUE_MAX = 5;
const AUTO_CONTINUE_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 16384;

const SKIP_HEADERS = new Set(["transfer-encoding", "connection", "content-length"]);

function requestUpstreamRaw(options) {
  return new Promise((resolve, reject) => {
    const { url, method, headers, body, signal } = options;
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const reqHeaders = { ...headers, "Content-Length": Buffer.byteLength(body || "") };
    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, method, headers: reqHeaders },
      (res) => { resolve({ status: res.statusCode, headers: res.headers, stream: res }); },
    );
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) { req.destroy(); reject(new Error("aborted")); return; }
      signal.addEventListener("abort", () => { req.destroy(); reject(new Error("aborted")); }, { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

function extractOutputText(sseEvents) {
  let text = "";
  for (const line of sseEvents) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
        text += parsed.choices[0].delta.content;
      }
    } catch {}
  }
  return text;
}

function isStreamComplete(allLines) {
  for (let i = allLines.length - 1; i >= 0; i--) {
    const line = allLines[i];
    if (line === "data: [DONE]") return true;
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason) return true;
      } catch {}
      return false;
    }
  }
  return false;
}

function buildContinueBody(originalBody, partialOutput) {
  const messages = [...(originalBody.messages || [])];
  if (partialOutput) {
    messages.push({ role: "assistant", content: partialOutput });
  }
  return { ...originalBody, messages };
}

function extractMessageContent(parsed) {
  try {
    return parsed.choices[0].message.content || "";
  } catch {
    return "";
  }
}

function extractMessageReasoning(parsed) {
  try {
    return parsed.choices[0].message.reasoning_content || "";
  } catch {
    return "";
  }
}

function mergeResponses(base, continuation) {
  try {
    const baseContent = extractMessageContent(base);
    const contContent = extractMessageContent(continuation);
    base.choices[0].message.content = baseContent + contContent;

    const baseReasoning = extractMessageReasoning(base);
    const contReasoning = extractMessageReasoning(continuation);
    if (baseReasoning || contReasoning) {
      base.choices[0].message.reasoning_content = baseReasoning + contReasoning;
    }

    if (continuation.choices && continuation.choices[0]) {
      base.choices[0].finish_reason = continuation.choices[0].finish_reason;
      if (continuation.choices[0].index !== undefined) {
        base.choices[0].index = continuation.choices[0].index;
      }
    }

    if (base.usage && continuation.usage) {
      base.usage.completion_tokens = (base.usage.completion_tokens || 0) + (continuation.usage.completion_tokens || 0);
      base.usage.prompt_tokens = (base.usage.prompt_tokens || 0) + (continuation.usage.prompt_tokens || 0);
      base.usage.total_tokens = (base.usage.total_tokens || 0) + (continuation.usage.total_tokens || 0);
    }
  } catch (err) {
    console.error("[mergeResponses] error:", err.message);
  }
  return base;
}

function streamWithAutoContinue(clientRes, initialResult, body, keys, getNextKey, startTime) {
  return new Promise((resolve, reject) => {
    const stream = initialResult.stream;
    let done = false;
    let buffer = "";
    const allLines = [];
    let lastDataTime = Date.now();

    const keepalive = setInterval(() => {
      if (!done && Date.now() - lastDataTime > 10000) {
        try { clientRes.write(": keepalive\n\n"); } catch {}
        lastDataTime = Date.now();
      }
    }, 5000);

    function finish() {
      clearInterval(keepalive);
      done = true;
      if (!clientRes.writableEnded) {
        try { clientRes.end(); } catch {}
      }
      resolve();
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
          allLines.push(`data: ${data}`);
          if (data === "[DONE]") {
            finish();
            return;
          }
          try { clientRes.write(`data: ${data}\n\n`); } catch {}
        } else if (line.startsWith(":")) {
          // SSE comment, skip
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        allLines.push(buffer.trim());
        if (buffer.startsWith("data: ")) {
          const data = buffer.slice(6);
          if (data === "[DONE]") {
            finish();
            return;
          }
          try { clientRes.write(`data: ${data}\n\n`); } catch {}
        }
      }

      if (isStreamComplete(allLines)) {
        finish();
        return;
      }

      const partialOutput = extractOutputText(allLines);
      console.log(`[auto-continue] stream incomplete, partial output: ${partialOutput.length} chars`);

      autoContinue(body, keys, getNextKey, clientRes, partialOutput, startTime, 1)
        .then(() => finish())
        .catch(() => finish());
    });

    stream.on("error", () => {
      clearInterval(keepalive);
      const partialOutput = extractOutputText(allLines);
      if (isStreamComplete(allLines)) {
        finish();
        return;
      }
      autoContinue(body, keys, getNextKey, clientRes, partialOutput, startTime, 1)
        .then(() => finish())
        .catch(() => finish());
    });

    stream.on("close", () => {
      if (!done) {
        clearInterval(keepalive);
        if (isStreamComplete(allLines)) {
          finish();
          return;
        }
        const partialOutput = extractOutputText(allLines);
        autoContinue(body, keys, getNextKey, clientRes, partialOutput, startTime, 1)
          .then(() => finish())
          .catch(() => finish());
      }
    });
  });
}

async function autoContinue(body, keys, getNextKey, clientRes, partialOutput, startTime, attempt) {
  if (attempt > AUTO_CONTINUE_MAX) {
    console.log(`[auto-continue] max attempts reached`);
    return;
  }
  if (Date.now() - startTime > AUTO_CONTINUE_TIMEOUT_MS) {
    console.log(`[auto-continue] timeout approaching, aborting`);
    return;
  }

  console.log(`[auto-continue] attempt ${attempt}, resuming from ${partialOutput.length} chars`);

  const continueBody = buildContinueBody(body, partialOutput);

  try {
    const result = await requestUpstreamRaw({
      url: KIMCHI_UPSTREAM,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getNextKey().key}`,
        ...KIMCHI_CLI_HEADERS,
      },
      body: JSON.stringify(continueBody),
      signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
    });

    if (result.status !== 200) {
      console.log(`[auto-continue] upstream returned ${result.status}`);
      return;
    }

    let buffer = "";
    const allLines = [];
    let lastDataTime = Date.now();

    const keepalive = setInterval(() => {
      if (Date.now() - lastDataTime > 10000) {
        try { clientRes.write(": keepalive\n\n"); } catch {}
        lastDataTime = Date.now();
      }
    }, 5000);

    await new Promise((res, rej) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearInterval(keepalive); res(); } };

      result.stream.on("data", (chunk) => {
        lastDataTime = Date.now();
        const text = chunk.toString("utf-8");
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            allLines.push(`data: ${data}`);
            if (data === "[DONE]") { finish(); return; }
            try { clientRes.write(`data: ${data}\n\n`); } catch {}
          }
        }
      });

      result.stream.on("end", () => {
        if (buffer.trim()) {
          allLines.push(buffer.trim());
          if (buffer.startsWith("data: ")) {
            const data = buffer.slice(6);
            if (data !== "[DONE]") try { clientRes.write(`data: ${data}\n\n`); } catch {}
          }
        }
        finish();
      });

      result.stream.on("error", finish);
      result.stream.on("close", finish);
    });

    if (!isStreamComplete(allLines)) {
      const newPartial = extractOutputText(allLines);
      await autoContinue(body, keys, getNextKey, clientRes, partialOutput + newPartial, startTime, attempt + 1);
    }
  } catch (err) {
    console.error(`[auto-continue] error:`, err.message);
  }
}

module.exports = async function handler(req, res) {
  if (!validateProxyApiKey(req, res)) {
    return;
  }

  if (req.method === "GET" && req.url && req.url.includes("action=stats")) {
    const url = new URL(req.url, "http://localhost");
    const range = url.searchParams.get("range") || "today";
    const stats = getStats(range);
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

    if (body.max_tokens === undefined || body.max_tokens === null) {
      body.max_tokens = DEFAULT_MAX_TOKENS;
    }

    model = body.model || "unknown";
    startTime = Date.now();
    const isStreaming = body.stream === true;

    if (isStreaming) {
      const result = await proxyToKimchiStreaming({
        upstreamUrl: KIMCHI_UPSTREAM,
        getNextKey,
        requestBody: body,
        requestHeaders: { "X-Request-Start": String(Date.now()) },
        signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
      });

      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(result.attempts));

      logRequest({
        model,
        status: result.status,
        elapsed: Date.now() - startTime,
        keyIndex: lastKeyIndex,
        inputTokens: body.messages ? body.messages.reduce((s, m) => s + (m.content || "").length / 4, 0) : 0,
        outputTokens: 0,
        method: "POST",
      });

      await streamWithAutoContinue(res, result, body, keys, getNextKey, startTime);
    } else {
      let result = await proxyToKimchi({
        upstreamUrl: KIMCHI_UPSTREAM,
        getNextKey,
        requestBody: body,
        requestHeaders: { "X-Request-Start": String(Date.now()) },
        maxRetries: Math.min(keys.length, 55),
        signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
      });

      if (result.status === 200) {
        let finalBody;
        try {
          finalBody = JSON.parse(result.body);
        } catch {
          finalBody = null;
        }

        if (finalBody) {
          let continued = false;
          let autoContinueAttempts = 0;

          for (let attempt = 1; attempt <= AUTO_CONTINUE_MAX; attempt++) {
            const finishReason = finalBody.choices?.[0]?.finish_reason;
            const content = extractMessageContent(finalBody);
            const reasoning = extractMessageReasoning(finalBody);

            const shouldContinue = finishReason === "length" || (!content && reasoning);
            if (!shouldContinue) {
              break;
            }
            if (Date.now() - startTime > AUTO_CONTINUE_TIMEOUT_MS) {
              console.log(`[auto-continue] non-streaming timeout approaching`);
              break;
            }

            continued = true;
            autoContinueAttempts++;
            console.log(`[auto-continue] non-streaming attempt ${attempt}, content: ${content.length} chars, reasoning: ${reasoning.length} chars`);

            const continueResult = await proxyToKimchi({
              upstreamUrl: KIMCHI_UPSTREAM,
              getNextKey,
              requestBody: buildContinueBody(body, content),
              requestHeaders: { "X-Request-Start": String(Date.now()) },
              maxRetries: Math.min(keys.length, 55),
              signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
            });

            if (continueResult.status !== 200) {
              break;
            }

            let continueBodyParsed;
            try {
              continueBodyParsed = JSON.parse(continueResult.body);
            } catch {
              break;
            }

            finalBody = mergeResponses(finalBody, continueBodyParsed);

            if (finalBody.choices?.[0]?.finish_reason !== "length" && extractMessageContent(finalBody)) {
              break;
            }
          }

          result.body = JSON.stringify(finalBody);
          res.setHeader("X-Proxy-Continued", String(continued));
          if (continued) {
            res.setHeader("X-Proxy-Continue-Attempts", String(autoContinueAttempts));
          }
        }
      }

      const elapsed = Date.now() - startTime;
      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(result.attempts));
      res.setHeader("X-Proxy-Elapsed-Ms", String(elapsed));

      let inputTokens = 0;
      let outputTokens = 0;
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || 0;
          outputTokens = parsed.usage.completion_tokens || 0;
        }
      } catch {}

      logRequest({
        model,
        status: result.status,
        elapsed,
        keyIndex: lastKeyIndex,
        inputTokens,
        outputTokens,
        method: "POST",
      });

      writeResponse(res, result);
    }
  } catch (error) {
    console.error("[completions proxy] error:", error);
    const elapsed = startTime ? Date.now() - startTime : 0;
    const err = error instanceof Error ? error : new Error(String(error));

    logRequest({
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
      error: "Failed to reach Kimchi API",
      keyIndex: lastKeyIndex,
      keyTotal: keys.length,
      attempts: 0,
      elapsedMs: elapsed,
      details: err.message,
    });
  }
};
