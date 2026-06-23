const { parseKeys, selectKey, throttleKey } = require("../lib/key-rotation.js");
const { proxyToKimchi, streamResponse } = require("../lib/proxy.js");

const KIMCHI_UPSTREAM = "https://llm.kimchi.dev/openai/v1/chat/completions";

module.exports = async function handler(req, res) {
  let key = "";
  let index = 0;
  let keys = [];
  let startTime = 0;

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const keysRaw = process.env.KIMCHI_API_KEYS;
    keys = parseKeys(keysRaw);

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

    key = keySelection.key;
    index = keySelection.index;

    if (throttleKey(key)) {
      const nextSelection = selectKey({ keys }, (index + 1) % keys.length);
      key = nextSelection.key;
      index = nextSelection.index;
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const upstreamUrl = KIMCHI_UPSTREAM;
    startTime = Date.now();
    let attempts = 0;

    const result = await proxyToKimchi({
      upstreamUrl,
      apiKey: key,
      requestBody: body,
      requestHeaders: {
        "X-Request-Start": String(Date.now()),
        "X-Proxy-Key-Index": String(index),
      },
    });
    attempts = result.attempts;

    const elapsed = Date.now() - startTime;

    res.setHeader("X-Proxy-Key-Index", String(index));
    res.setHeader("X-Proxy-Key-Total", String(keys.length));
    res.setHeader("X-Proxy-Attempts", String(attempts));
    res.setHeader("X-Proxy-Elapsed-Ms", String(elapsed));

    await streamResponse(res, result.response);
  } catch (error) {
    console.error("[completions proxy] error:", error);
    const elapsed = startTime ? Date.now() - startTime : 0;
    const err = error instanceof Error ? error : new Error(String(error));

    if (key && err.message.includes("HTTP 429")) {
      throttleKey(key);
    }

    return res.status(502).json({
      ok: false,
      error: "Failed to reach Kimchi API",
      keyIndex: index,
      keyTotal: keys.length,
      attempts: 0,
      elapsedMs: elapsed,
      details: err.message,
    });
  }
};
