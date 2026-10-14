// Live demo on Arc mainnet: two wallets deposit into the vault, sign opposite
// EIP-712 orders, send them to the attested engine, and the engine settles the
// match on-chain. Also checks the engine rejects a tampered order.
//
//   TRADER_A_KEY=0x.. TRADER_B_KEY=0x.. GIVE_A=<token> GIVE_B=<token> AMOUNT=<6-dec units> \
//   node scripts/demo-trade.mjs
//
// With GIVE_A == GIVE_B (e.g. USDC both ways) it is a same-asset self-match at
// equal size, the only same-token trade the vault allows.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "engine", "package.json"));
const { createPublicClient, createWalletClient, defineChain, http, parseAbi } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", "arc-mainnet.json"), "utf8"));
const RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const USDC = "0x3600000000000000000000000000000000000000";
const GIVE_A = process.env.GIVE_A || USDC;
const GIVE_B = process.env.GIVE_B || USDC;
const AMOUNT = BigInt(process.env.AMOUNT || "1000000");

const chain = defineChain({
  id: dep.chainId,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function deposit(address,uint256)",
  "function balanceOf(address,address) view returns (uint256)",
]);

async function ensureDeposit(key, token) {
  const acct = privateKeyToAccount(key);
  const w = createWalletClient({ account: acct, chain, transport: http(RPC) });
  const have = await pub.readContract({ address: dep.settlementVault, abi: vaultAbi, functionName: "balanceOf", args: [token, acct.address] });
  if (have >= AMOUNT) return;
  const allowance = await pub.readContract({ address: token, abi: erc20, functionName: "allowance", args: [acct.address, dep.settlementVault] });
  if (allowance < AMOUNT) {
    const h = await w.writeContract({ address: token, abi: erc20, functionName: "approve", args: [dep.settlementVault, AMOUNT * 10n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`approve ${acct.address}: ${h}`);
  }
  const h = await w.writeContract({ address: dep.settlementVault, abi: vaultAbi, functionName: "deposit", args: [token, AMOUNT - have] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`deposit ${acct.address}: ${h} ${r.status}`);
}

const types = {
  Order: [
    { name: "party", type: "address" },
    { name: "giveToken", type: "address" },
    { name: "giveAmount", type: "uint256" },
    { name: "wantToken", type: "address" },
    { name: "wantAmount", type: "uint256" },
    { name: "ts", type: "uint64" },
    { name: "enclaveId", type: "bytes32" },
  ],
};
const domain = { name: "Attest", version: "1", chainId: dep.chainId, verifyingContract: dep.settlementVault };

async function signed(key, giveToken, wantToken) {
  const acct = privateKeyToAccount(key);
  const message = { party: acct.address, giveToken, giveAmount: AMOUNT, wantToken, wantAmount: AMOUNT, ts: BigInt(Date.now()), enclaveId: dep.enclaveId };
  const signature = await acct.signTypedData({ domain, types, primaryType: "Order", message });
  const order = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { order, signature };
}

const post = (body) =>
  fetch(`${dep.engineUrl}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  );

const A = process.env.TRADER_A_KEY;
const B = process.env.TRADER_B_KEY;
await ensureDeposit(A, GIVE_A);
await ensureDeposit(B, GIVE_B);

const forged = await signed(A, GIVE_A, GIVE_B);
forged.order.wantAmount = "1";
console.log("tampered order ->", (await post(forged)).status, "(expected 401)");

console.log("order A ->", (await post(await signed(A, GIVE_A, GIVE_B))).body.order);
const res = await post(await signed(B, GIVE_B, GIVE_A));
console.log("order B ->", JSON.stringify(res.body, null, 2));
if (!res.body.settled) process.exit(1);
console.log(`settled on Arc: ${res.body.settled.txHash}`);
