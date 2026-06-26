const { parseCfCredentials, isCfEnabled } = require("./lib/cloudflare.js");

function mask(s) {
  if (!s) return "";
  if (s.length <= 8) return "***";
  return s.slice(0, 6) + "..." + s.slice(-4);
}

module.exports = async function handler(req, res) {
  const credentials = parseCfCredentials();
  res.status(200).json({
    cloudflareEnabled: isCfEnabled(),
    credentialsCount: credentials.length,
    first: credentials[0] ? { accountId: mask(credentials[0].accountId), tokenPrefix: mask(credentials[0].token) } : null,
    last: credentials[credentials.length - 1] ? { accountId: mask(credentials[credentials.length - 1].accountId), tokenPrefix: mask(credentials[credentials.length - 1].token) } : null,
    rawLength: (process.env.CLOUDFLARE_CREDENTIALS || "").length,
  });
};
