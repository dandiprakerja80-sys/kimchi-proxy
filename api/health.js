const { parseKeys, selectKey, throttleKey, getKeyStatus } = require("./lib/key-rotation.js");
const { validateProxyApiKey } = require("./lib/auth.js");
const { isCfEnabled, parseCfCredentials } = require("./lib/cloudflare.js");

module.exports = async function handler(req, res) {
  if (!validateProxyApiKey(req, res)) {
    return;
  }

  try {
    const keysRaw = process.env.KIMCHI_API_KEYS;
    const keys = parseKeys(keysRaw);
    const cfCredentials = parseCfCredentials();

    const status = {
      ok: true,
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      keysConfigured: keys.length,
      keyStatus: getKeyStatus({ keys }),
      cloudflare: {
        enabled: isCfEnabled(),
        credentialsConfigured: cfCredentials.length,
        models: ["kimi-k2.7", "kimi-k2.6"],
      },
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
