const { parseKeys, selectKey, throttleKey, isKeyThrottled } = require("../../lib/key-rotation.js");
const { proxyToKimchi, proxyToKimchiStreaming, writeResponse, streamResponse } = require("../../lib/proxy.js");

const KIMCHI_UPSTREAM = "https://llm.kimchi.dev/openai/v1/chat/completions";

module.exports = async function handler(req, res) {
  const keysRaw = process.env.KIMCHI_API_KEYS;
  const keys = parseKeys(keysRaw);
  let startTime = 0;
  let lastKeyIndex = 0;

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

    startTime = Date.now();
    const isStreaming = body.stream === true;

    if (isStreaming) {
      const result = await proxyToKimchiStreaming({
        upstreamUrl: KIMCHI_UPSTREAM,
        getNextKey,
        requestBody: body,
        requestHeaders: {
          "X-Request-Start": String(Date.now()),
        },
        signal: AbortSignal.timeout(55000),
      });

      const elapsed = Date.now() - startTime;
      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(result.attempts));
      res.setHeader("X-Proxy-Elapsed-Ms", String(elapsed));

      streamResponse(res, result);
    } else {
      const result = await proxyToKimchi({
        upstreamUrl: KIMCHI_UPSTREAM,
        getNextKey,
        requestBody: body,
        requestHeaders: {
          "X-Request-Start": String(Date.now()),
        },
        maxRetries: Math.min(keys.length, 55),
        signal: AbortSignal.timeout(55000),
      });

      const elapsed = Date.now() - startTime;
      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(result.attempts));
      res.setHeader("X-Proxy-Elapsed-Ms", String(elapsed));

      writeResponse(res, result);
    }
  } catch (error) {
    console.error("[completions proxy] error:", error);
    const elapsed = startTime ? Date.now() - startTime : 0;
    const err = error instanceof Error ? error : new Error(String(error));

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
