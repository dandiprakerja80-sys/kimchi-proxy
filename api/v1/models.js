const { parseKeys, selectKey, throttleKey } = require("../../lib/key-rotation.js");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const keysRaw = process.env.KIMCHI_API_KEYS;
    const keys = parseKeys(keysRaw);

    if (keys.length === 0) {
      return res.status(500).json({ error: "No API keys configured. Set KIMCHI_API_KEYS env var." });
    }

    const keySelection = selectKey({ keys });
    const { key, index } = keySelection;

    const response = await fetch("https://llm.kimchi.dev/v1/models/metadata?include_in_cli=true", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "kimchi-proxy/1.0.0",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throttleKey(key);
      }
      return res.status(response.status).json({
        error: `Metadata fetch failed: ${response.status} ${response.statusText}`,
        keyIndex: index,
      });
    }

    const data = await response.json();

    res.setHeader("X-Proxy-Key-Index", String(index));
    res.setHeader("X-Proxy-Key-Total", String(keys.length));

    return res.status(200).json(data);
  } catch (error) {
    console.error("[models proxy] error:", error);
    return res.status(502).json({
      error: "Failed to fetch models metadata",
      details: error instanceof Error ? error.message : String(error),
    });
  }
};
