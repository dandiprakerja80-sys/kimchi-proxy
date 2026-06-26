const https = require("https");
const { URL } = require("url");
const { parseCfCredentials, isCfEnabled, mapModelToCf } = require("./lib/cloudflare.js");

function mask(s) {
  if (!s) return "";
  if (s.length <= 8) return "***";
  return s.slice(0, 6) + "..." + s.slice(-4);
}

async function testCredential(credential) {
  const model = mapModelToCf("kimi-k2.7");
  const url = `https://api.cloudflare.com/client/v4/accounts/${credential.accountId}/ai/v1/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 5,
    stream: false,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    return { status: res.status, bodyPrefix: text.slice(0, 200) };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  const credentials = parseCfCredentials();
  const firstTest = credentials[0] ? await testCredential(credentials[0]) : null;

  res.status(200).json({
    cloudflareEnabled: isCfEnabled(),
    credentialsCount: credentials.length,
    first: credentials[0] ? { accountId: mask(credentials[0].accountId), tokenPrefix: mask(credentials[0].token) } : null,
    last: credentials[credentials.length - 1] ? { accountId: mask(credentials[credentials.length - 1].accountId), tokenPrefix: mask(credentials[credentials.length - 1].token) } : null,
    rawLength: (process.env.CLOUDFLARE_CREDENTIALS || "").length,
    firstTest,
  });
};
