/**
 * Proxy API key validator.
 * Clients must send Authorization: Bearer <PROXY_API_KEY>.
 * If PROXY_API_KEY is not set, allow all requests.
 */

function extractBearerToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return auth.trim();
}

function validateProxyApiKey(req, res) {
  const expected = process.env.PROXY_API_KEY;
  if (!expected) {
    return true;
  }

  const provided = extractBearerToken(req);
  if (provided !== expected) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized",
      message: "Invalid or missing PROXY_API_KEY. Send Authorization: Bearer <key>.",
    });
    return false;
  }

  return true;
}

module.exports = { validateProxyApiKey, extractBearerToken };
