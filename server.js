const http = require("http");

const PORT = 7860;

function wrapRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = (data) => {
    res.end(data);
    return res;
  };
  return res;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(body);
      }
    });
    req.on("error", reject);
  });
}

const handlers = {
  "/api/v1/chat/completions": () => require("./api/v1/chat/completions.js"),
  "/v1/chat/completions": () => require("./api/v1/chat/completions.js"),
  "/api/v1/models": () => require("./api/v1/models.js"),
  "/v1/models": () => require("./api/v1/models.js"),
  "/api/health": () => require("./api/health.js"),
  "/health": () => require("./api/health.js"),
  "/api/dashboard": () => require("./api/dashboard.js"),
  "/dashboard": () => require("./api/dashboard.js"),
  "/api/debug/env": () => require("./api/dashboard.js"),
};

const server = http.createServer(async (req, res) => {
  wrapRes(res);
  req.body = await readBody(req);

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/") {
      return res.status(200).json({
        ok: true,
        name: "Kimchi Proxy",
        endpoints: ["/v1/chat/completions", "/v1/models", "/health", "/dashboard"],
      });
    }

    const handlerFactory = handlers[path];
    if (handlerFactory) {
      const handler = handlerFactory();
      return await handler(req, res);
    }

    res.writeHead(404);
    res.end("Not Found");
  } catch (err) {
    console.error("[server] error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
