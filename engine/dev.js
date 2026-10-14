/**
 * LOCAL DEVELOPMENT RUNNER -- not part of the TEE deployment.
 *
 * Runs index.js where there is no dstack guest agent: dstack.js's `getKey` returns
 * DEV_ENGINE_KEY (0x-hex secp256k1 key) and `getQuote` returns a synthetic
 * quote with the real layout, signed by DEV_QUOTE_KEY (0x-hex P-256 key).
 * Deploy the verifier with that P-256 key's public point and the MRTD/RTMR3
 * below and the whole register -> order -> settle path runs for real against
 * a local chain. Nothing about it is attested.
 *
 *   DEV_ENGINE_KEY=0x.. DEV_QUOTE_KEY=0x.. ADMIN_KEY=dev ARC_RPC_URL=http://127.0.0.1:8545 \
 *   ARC_CHAIN_ID=31337 PORT=8787 node dev.js
 */

import crypto from "node:crypto";
import { p256 } from "@noble/curves/p256";

const DEV_MRTD = Buffer.alloc(48, 0x11);
const DEV_RTMR3 = Buffer.alloc(48, 0x33);

for (const k of ["DEV_ENGINE_KEY", "DEV_QUOTE_KEY"]) {
  if (!process.env[k]) {
    console.error(`dev.js: set ${k}`);
    process.exit(1);
  }
}
const engineKey = Buffer.from(process.env.DEV_ENGINE_KEY.slice(2), "hex");
const quoteKey = process.env.DEV_QUOTE_KEY.slice(2);

function fakeQuote(reportData) {
  const q = Buffer.alloc(764);
  q.writeUInt16LE(4, 0);
  DEV_MRTD.copy(q, 184);
  DEV_RTMR3.copy(q, 520);
  Buffer.from(reportData).copy(q, 568, 0, 64);
  const digest = crypto.createHash("sha256").update(q.subarray(0, 632)).digest();
  const sig = p256.sign(digest, quoteKey, { prehash: false, lowS: false });
  q.writeUInt32LE(64 + 64, 632);
  Buffer.from(sig.toCompactRawBytes()).copy(q, 636);
  Buffer.from(p256.getPublicKey(quoteKey, false)).subarray(1).copy(q, 700);
  return q.toString("hex");
}

globalThis.__DSTACK_MOCK__ = {
  async getKey() {
    return Uint8Array.from(engineKey);
  },
  async getQuote(reportData) {
    return fakeQuote(reportData);
  },
};

if (process.argv[2] === "--print-verifier-args") {
  const pub = Buffer.from(p256.getPublicKey(quoteKey, false));
  console.log(
    JSON.stringify({
      mrtd: "0x" + DEV_MRTD.toString("hex"),
      rtmr3: "0x" + DEV_RTMR3.toString("hex"),
      keyX: "0x" + pub.subarray(1, 33).toString("hex"),
      keyY: "0x" + pub.subarray(33).toString("hex"),
    }),
  );
  process.exit(0);
}

await import("./index.js");
