const https = require("https");
const { URL } = require("url");
const { parseCfCredentials, isCfEnabled, mapModelToCf } = require("./lib/cloudflare.js");

function mask(s) {
  if (!s) return "";
  if (s.length <= 8) return "***";
  return s.slice(0, 6) + "..." + s.slice(-4);
}

function testCredential(credential) {
  return new Promise((resolve) => {
    const model = mapModelToCf("kimi-k2.7");
    const url = `https://api.cloudflare.com/client/v4/accounts/${credential.accountId}/ai/v1/chat/completions`;
    const parsed = new URL(url);
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
      stream: false,
    });

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.token}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const respBody = Buffer.concat(chunks).toString("utf-8");
          let parsedBody;
          try {
            parsedBody = JSON.parse(respBody);
          } catch {
            parsedBody = respBody;
          }
          resolve({ status: response.statusCode, bodyPrefix: typeof parsedBody === "string" ? parsedBody.slice(0, 200) : JSON.stringify(parsedBody).slice(0, 200) });
        });
      },
    );

    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    req.on("timeout", () => resolve({ status: 0, error: "timeout" }));
    req.write(body);
    req.end();
  });
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
