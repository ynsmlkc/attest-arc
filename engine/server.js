// The few Express features the engine used (JSON bodies, req.query,
// res.status().json(), per-route middleware, CORS) on plain node:http.
// Express pulled ~750 KB into the bundle, too much to embed in the compose
// file that RTMR3 measures.
import http from "node:http";

const BODY_LIMIT = 64 * 1024;

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    const body = JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    res.setHeader("Content-Type", "application/json");
    res.end(body);
    return res;
  };
  return res;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function createApp() {
  const routes = new Map(); // "METHOD /path" -> handlers[]
  const add = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers);

  const server = http.createServer(async (req, rawRes) => {
    const res = decorate(rawRes);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();

    const url = new URL(req.url, "http://localhost");
    const handlers = routes.get(`${req.method} ${url.pathname}`);
    if (!handlers) return res.status(404).json({ ok: false, error: "not found" });
    req.query = Object.fromEntries(url.searchParams);
    try {
      req.body = req.method === "POST" ? await readJson(req) : {};
    } catch (err) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }

    let i = 0;
    const next = async () => {
      const h = handlers[i++];
      if (h) await h(req, res, next);
    };
    try {
      await next();
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  return { get: add("GET"), post: add("POST"), listen: (port, cb) => server.listen(port, cb) };
}
