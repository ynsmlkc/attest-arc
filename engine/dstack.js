// Minimal client for the dstack guest agent (the two calls the engine uses),
// talking HTTP over its unix socket the same way @phala/dstack-sdk does.
// Kept dependency-free so the whole engine bundles small enough to embed in
// the compose file (and so the compose, which RTMR3 measures, holds all code).
// dev.js replaces it by setting globalThis.__DSTACK_MOCK__.
import fs from "node:fs";
import http from "node:http";

const SOCKETS = ["/var/run/dstack.sock", "/run/dstack.sock", "/var/run/dstack/dstack.sock", "/run/dstack/dstack.sock"];

function rpc(path, body) {
  const socketPath = SOCKETS.find((p) => fs.existsSync(p)) ?? SOCKETS[0];
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 30_000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json && json.error) reject(new Error(json.error));
            else resolve(json);
          } catch {
            reject(new Error(`dstack ${path}: unparseable response (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`dstack ${path}: timed out`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/** 32-byte key derived inside the enclave for `path` (secp256k1). */
export async function getKey(path) {
  if (globalThis.__DSTACK_MOCK__) return globalThis.__DSTACK_MOCK__.getKey(path);
  const res = await rpc("/GetKey", { path, purpose: "", algorithm: "secp256k1" });
  return Uint8Array.from(Buffer.from(res.key, "hex"));
}

/** Raw TDX quote (hex) with `reportData` (<= 64 bytes) in REPORT_DATA. */
export async function getQuote(reportData) {
  if (globalThis.__DSTACK_MOCK__) return globalThis.__DSTACK_MOCK__.getQuote(reportData);
  const res = await rpc("/GetQuote", { report_data: Buffer.from(reportData).toString("hex") });
  return res.quote;
}
