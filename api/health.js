const { parseKeys, selectKey, throttleKey, getKeyStatus } = require("./lib/key-rotation.js");

module.exports = async function handler(req, res) {
  try {
    const keysRaw = process.env.KIMCHI_API_KEYS;
    const keys = parseKeys(keysRaw);

    const status = {
      ok: true,
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      keysConfigured: keys.length,
      keyStatus: getKeyStatus({ keys }),
    };

    if (keys.length === 0) {
      status.ok = false;
      status.error = "No API keys configured";
    }

    res.status(status.ok ? 200 : 503).json(status);
  } catch (err) {
    console.error("[health] error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
};
