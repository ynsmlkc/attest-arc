/**
 * Attest matching engine for Arc. Runs inside a real Phala Cloud TDX CVM.
 *
 * On startup it derives its Arc (EVM) account from dstack's enclave-bound key
 * derivation (the guest agent's GetKey, see dstack.js), exactly like the Stellar version derived
 * its ed25519 key: the 32 bytes are used directly as the private key (dstack's
 * own `toViemAccount` helper does the same). The key never leaves this process.
 *
 * Registration is self-contained: POST /register asks the verifier for
 * `registrationBinding(enclaveId, engine)`, asks the TDX hardware for a quote
 * with that value in REPORT_DATA, and submits the quote itself. The verifier
 * only accepts a quote whose REPORT_DATA names the sender, so a quote can't be
 * replayed by anyone else, on any other chain or verifier.
 *
 * Orders are EIP-712 signed by traders. The engine checks the signature, keeps
 * an in-memory book (matcher.js: price-time priority, partial fills, trades at
 * the maker's price) and settles each fill with SettlementVault.settle(), which
 * re-verifies every signature, fill size and limit price on-chain.
 */

import crypto from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  getAddress,
  isAddress,
  isHex,
  hexToBytes,
  bytesToHex,
  padHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import matcher from "./matcher.cjs";
import { getKey, getQuote } from "./dstack.js";
import { createApp } from "./server.js";

const { findFill, applyFill } = matcher;

const PORT = process.env.PORT || 80;
const RPC_URL = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042);
const KEY_PATH = process.env.ENGINE_KEY_PATH || "attest-arc/matching-engine/v1";
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const arc = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 5042 ? "Arc" : "Arc Testnet",
  // Native USDC has 18 decimals; the ERC-20 interface the vault uses has 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const verifierAbi = [
  {
    type: "function",
    name: "registrationBinding",
    stateMutability: "view",
    inputs: [
      { name: "enclaveId", type: "bytes32" },
      { name: "engine", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "registerVerifiedEnclave",
    stateMutability: "nonpayable",
    inputs: [
      { name: "enclaveId", type: "bytes32" },
      { name: "payload", type: "bytes" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getEngineAddress",
    stateMutability: "view",
    inputs: [{ name: "enclaveId", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
];

const orderComponents = [
  { name: "party", type: "address" },
  { name: "giveToken", type: "address" },
  { name: "giveAmount", type: "uint256" },
  { name: "wantToken", type: "address" },
  { name: "wantAmount", type: "uint256" },
  { name: "ts", type: "uint64" },
  { name: "enclaveId", type: "bytes32" },
];

const vaultAbi = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "enclaveId", type: "bytes32" },
      { name: "a", type: "tuple", components: orderComponents },
      { name: "sigA", type: "bytes" },
      { name: "fillA", type: "uint256" },
      { name: "b", type: "tuple", components: orderComponents },
      { name: "sigB", type: "bytes" },
      { name: "fillB", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

// Must match SettlementVault's EIP712("Attest", "1") and ORDER_TYPEHASH, and
// web/src/lib/orderSigning.ts.
const ORDER_TYPES = { Order: orderComponents };

function requireAdminKey(req, res, next) {
  const provided = req.headers["x-admin-key"];
  if (!ADMIN_KEY || typeof provided !== "string") {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  next();
}

let account = null;
let publicClient = null;
let walletClient = null;
const orders = [];
const matches = [];
let nextOrderId = 1;
let lastAttestation = null; // { quote, reportData, enclaveId, verifier, txHash, at }

// Runtime config, not compose env: RTMR3 covers the whole compose file, so
// baking deploy addresses in would change the measurement on every redeploy.
let vaultAddress = process.env.SETTLEMENT_VAULT || null;
let verifierAddress = process.env.ATTESTATION_VERIFIER || null;
let enclaveId = process.env.ENCLAVE_ID || null;

async function deriveAccount() {
  return privateKeyToAccount(bytesToHex(await getKey(KEY_PATH)));
}

function domain() {
  return { name: "Attest", version: "1", chainId: CHAIN_ID, verifyingContract: vaultAddress };
}

// --- Order intake ----------------------------------------------------------

// EIP-712 has no replay window of its own at intake; the vault's fill
// tracking stops double settlement, this stops spamming the book with copies.
const SIGNATURE_WINDOW_MS = 120_000;
const seenSignatures = new Map();

function parseOrder(body) {
  const o = body && body.order;
  if (!o || typeof body.signature !== "string" || !isHex(body.signature)) {
    return { error: "body must be { order, signature }" };
  }
  for (const k of ["party", "giveToken", "wantToken"]) {
    if (!isAddress(o[k] || "")) return { error: `${k} must be an address` };
  }
  const intStr = (v) => typeof v === "string" && /^[1-9][0-9]{0,30}$/.test(v);
  if (!intStr(o.giveAmount) || !intStr(o.wantAmount) || !intStr(String(o.ts))) {
    return { error: "giveAmount/wantAmount/ts must be positive integer strings (6-decimal units / ms)" };
  }
  if (!isHex(o.enclaveId || "") || o.enclaveId.length !== 66) return { error: "enclaveId must be bytes32" };
  const giveAmount = BigInt(o.giveAmount);
  const wantAmount = BigInt(o.wantAmount);
  if (giveAmount > BigInt(Number.MAX_SAFE_INTEGER) || wantAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { error: "amount too large" };
  }
  return {
    order: {
      party: getAddress(o.party),
      giveToken: getAddress(o.giveToken),
      giveAmount,
      wantToken: getAddress(o.wantToken),
      wantAmount,
      ts: BigInt(o.ts),
      enclaveId: o.enclaveId.toLowerCase(),
    },
    signature: body.signature,
  };
}

async function verifyOrder(order, signature) {
  const now = Date.now();
  for (const [sig, at] of seenSignatures) if (now - at > SIGNATURE_WINDOW_MS) seenSignatures.delete(sig);
  if (Math.abs(now - Number(order.ts)) > SIGNATURE_WINDOW_MS) return "timestamp outside the signing window";
  if (seenSignatures.has(signature)) return "signature already used";
  if (order.enclaveId !== enclaveId.toLowerCase()) return "order is for a different enclave";
  // publicClient.verifyTypedData also accepts ERC-1271 smart accounts, the
  // same set SignatureChecker accepts on-chain.
  const ok = await publicClient.verifyTypedData({
    address: order.party,
    domain: domain(),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
    signature,
  });
  if (!ok) return "signature does not match party";
  seenSignatures.set(signature, now);
  return null;
}

// --- Settlement ------------------------------------------------------------

const FAILED_PAIR_TTL_MS = 60_000;
const failedPairs = new Map();

function isPairBlocked(maker, taker) {
  const key = `${maker.id}:${taker.id}`;
  const until = failedPairs.get(key);
  if (until === undefined) return false;
  if (Date.now() > until) {
    failedPairs.delete(key);
    return false;
  }
  return true;
}

// settle awaits a chain round-trip between findFill and the book update, so
// concurrent requests are serialized. The tail never rejects.
let settleQueue = Promise.resolve();
function withSettleLock(fn) {
  const run = settleQueue.then(fn);
  settleQueue = run.catch(() => {});
  return run;
}

async function settleAllMatches() {
  const records = [];
  let error = null;
  for (;;) {
    const fill = findFill(orders, isPairBlocked);
    if (!fill) break;
    try {
      records.push(await settleFill(fill));
    } catch (err) {
      console.error(err);
      error = err;
      failedPairs.set(`${fill.maker.id}:${fill.taker.id}`, Date.now() + FAILED_PAIR_TTL_MS);
    }
  }
  return { records, error };
}

function toTuple(o) {
  return {
    party: o.party,
    giveToken: o.giveToken,
    giveAmount: BigInt(o.giveAmount),
    wantToken: o.wantToken,
    wantAmount: BigInt(o.wantAmount),
    ts: BigInt(o.ts),
    enclaveId: o.enclaveId,
  };
}

async function settleFill(fill) {
  const a = fill.maker;
  const b = fill.taker;
  const args = [enclaveId, toTuple(a), a.signature, fill.amountMaker, toTuple(b), b.signature, fill.amountTaker];
  // Simulate first: a revert costs nothing and returns the vault's reason.
  const { request } = await publicClient.simulateContract({
    account,
    address: vaultAddress,
    abi: vaultAbi,
    functionName: "settle",
    args,
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`settle reverted: ${hash}`);

  for (const done of applyFill(fill)) orders.splice(orders.indexOf(done), 1);
  const record = {
    orderAId: a.id,
    orderBId: b.id,
    txHash: hash,
    at: new Date().toISOString(),
    partyA: a.party,
    partyB: b.party,
    giveTokenA: a.giveToken,
    giveAmountA: fill.amountMaker.toString(),
    giveTokenB: b.giveToken,
    giveAmountB: fill.amountTaker.toString(),
  };
  matches.push(record);
  return record;
}

// --- Attestation -----------------------------------------------------------

// TDX DCAP v4 quote layout (same offsets the verifier uses): signed payload
// 0..632, signature data length 632..636, ECDSA r||s 636..700, attestation
// key 700..764.
function parseQuote(quoteHex) {
  const q = hexToBytes(quoteHex.startsWith("0x") ? quoteHex : `0x${quoteHex}`);
  if (q.length < 764) throw new Error(`quote too short: ${q.length} bytes`);
  return {
    payload: bytesToHex(q.slice(0, 632)),
    r: bytesToHex(q.slice(636, 668)),
    s: bytesToHex(q.slice(668, 700)),
    keyX: bytesToHex(q.slice(700, 732)),
    keyY: bytesToHex(q.slice(732, 764)),
    mrtd: bytesToHex(q.slice(184, 232)),
    rtmr3: bytesToHex(q.slice(520, 568)),
    reportData: bytesToHex(q.slice(568, 632)),
  };
}

async function quoteFor(reportData32) {
  return getQuote(hexToBytes(padHex(reportData32, { size: 64, dir: "right" })));
}

async function main() {
  console.log(`Deriving engine key from dstack (path=${KEY_PATH})...`);
  account = await deriveAccount();
  publicClient = createPublicClient({ chain: arc, transport: http(RPC_URL) });
  walletClient = createWalletClient({ account, chain: arc, transport: http(RPC_URL) });
  console.log(`Engine Arc address: ${account.address}`);

  const app = createApp();

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/pubkey", (_req, res) => res.json({ address: account.address }));
  app.get("/config", (_req, res) =>
    res.json({ chainId: CHAIN_ID, vault: vaultAddress, verifier: verifierAddress, enclaveId, engine: account.address }),
  );

  app.post("/configure", requireAdminKey, (req, res) => {
    const { vault, verifier, enclaveId: e } = req.body || {};
    if (vault) vaultAddress = getAddress(vault);
    if (verifier) verifierAddress = getAddress(verifier);
    if (e) enclaveId = e;
    res.json({ ok: true, vault: vaultAddress, verifier: verifierAddress, enclaveId });
  });

  // A fresh quote over an arbitrary 32-byte challenge, so anyone can check
  // this engine is running the attested code right now (not only at
  // registration time).
  app.get("/attestation", async (req, res) => {
    try {
      const challenge = req.query.challenge;
      if (challenge !== undefined && !(isHex(challenge) && challenge.length === 66)) {
        return res.status(400).json({ ok: false, error: "challenge must be bytes32 hex" });
      }
      if (challenge === undefined && lastAttestation) return res.json({ ok: true, ...lastAttestation });
      const quote = await quoteFor(challenge || padHex("0x", { size: 32 }));
      res.json({ ok: true, quote, parsed: parseQuote(quote) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/register", requireAdminKey, async (_req, res) => {
    try {
      if (!verifierAddress || !enclaveId) throw new Error("configure verifier and enclaveId first");
      const binding = await publicClient.readContract({
        address: verifierAddress,
        abi: verifierAbi,
        functionName: "registrationBinding",
        args: [enclaveId, account.address],
      });
      const quote = await quoteFor(binding);
      const q = parseQuote(quote);
      const { request } = await publicClient.simulateContract({
        account,
        address: verifierAddress,
        abi: verifierAbi,
        functionName: "registerVerifiedEnclave",
        args: [enclaveId, q.payload, q.r, q.s],
      });
      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`register reverted: ${hash}`);
      lastAttestation = { quote, parsed: q, enclaveId, verifier: verifierAddress, txHash: hash, at: new Date().toISOString() };
      res.json({ ok: true, txHash: hash, engine: account.address, binding });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: String(err.shortMessage || err.message || err) });
    }
  });

  app.post("/orders", async (req, res) => {
    if (!vaultAddress || !enclaveId) {
      return res.status(503).json({ ok: false, error: "engine not configured yet" });
    }
    const parsed = parseOrder(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    let reason;
    try {
      reason = await verifyOrder(parsed.order, parsed.signature);
    } catch (err) {
      reason = `signature check failed: ${String(err.shortMessage || err.message || err)}`;
    }
    if (reason) return res.status(401).json({ ok: false, error: reason });

    const o = parsed.order;
    const order = {
      id: nextOrderId++,
      party: o.party,
      giveToken: o.giveToken,
      giveAmount: Number(o.giveAmount),
      wantToken: o.wantToken,
      wantAmount: Number(o.wantAmount),
      remaining: Number(o.giveAmount),
      ts: o.ts.toString(),
      enclaveId: o.enclaveId,
      signature: parsed.signature,
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    const { error } = await withSettleLock(settleAllMatches);
    const fills = matches.filter((m) => m.orderAId === order.id || m.orderBId === order.id);
    const { signature, ...publicOrder } = order;
    if (fills.length === 0 && error) {
      return res.status(500).json({ ok: true, order: publicOrder, settleError: String(error.shortMessage || error.message || error) });
    }
    res.json({ ok: true, order: publicOrder, settled: fills[0] || null, fills });
  });

  app.get("/orders", (_req, res) => res.json({ orders: orders.map(({ signature, ...rest }) => rest) }));
  app.get("/matches", (_req, res) => res.json({ matches }));

  app.listen(PORT, () => console.log(`attest-arc engine listening on :${PORT}`));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
