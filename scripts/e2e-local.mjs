// End-to-end check of the whole path on a local anvil chain, with the engine
// running under dev.js (synthetic quotes, nothing attested):
//   deploy -> engine self-registers -> two traders deposit and sign
//   EIP-712 orders -> engine matches and settles -> balances checked.
//
//   node scripts/e2e-local.mjs   (from the repo root; needs anvil + forge)

import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "engine", "package.json"));
const {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  keccak256,
  toHex,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const RPC = "http://127.0.0.1:8545";
const ENGINE_URL = "http://127.0.0.1:8787";
// anvil's well-known dev keys: 0 deploys, 1 is the engine, 2/3 trade.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const QUOTE_KEY = "0x" + "42".repeat(32);
const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) });

const children = [];
const cleanup = () => children.forEach((c) => c.kill());
process.on("exit", cleanup);

function forgeCreate(contract, args = []) {
  const out = execFileSync(
    "forge",
    ["create", contract, "--rpc-url", RPC, "--private-key", KEYS[0], "--broadcast", "--json", ...(args.length ? ["--constructor-args", ...args] : [])],
    { cwd: path.join(root, "contracts"), encoding: "utf8" },
  );
  return JSON.parse(out.slice(out.indexOf("{"))).deployedTo;
}

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

const anvil = spawn("anvil", ["--hardfork", "osaka", "--silent"], { stdio: "inherit" });
children.push(anvil);
await sleep(1500);

const devEnv = { ...process.env, DEV_ENGINE_KEY: KEYS[1], DEV_QUOTE_KEY: QUOTE_KEY };
const vargs = JSON.parse(
  execFileSync("node", ["dev.js", "--print-verifier-args"], { cwd: path.join(root, "engine"), env: devEnv, encoding: "utf8" }),
);
const verifier = forgeCreate("src/AttestationVerifier.sol:AttestationVerifier", [vargs.mrtd, vargs.rtmr3, vargs.keyX, vargs.keyY]);
const vault = forgeCreate("src/SettlementVault.sol:SettlementVault", [verifier]);
const usdc = forgeCreate("test/MockToken.sol:MockToken", ["USDC"]);
const eurc = forgeCreate("test/MockToken.sol:MockToken", ["EURC"]);
console.log({ verifier, vault, usdc, eurc });

const engine = spawn("node", ["dev.js"], {
  cwd: path.join(root, "engine"),
  env: { ...devEnv, ADMIN_KEY: "dev", ARC_RPC_URL: RPC, ARC_CHAIN_ID: "31337", PORT: "8787" },
  stdio: "inherit",
});
children.push(engine);
await waitFor(`${ENGINE_URL}/health`);

const enclaveId = keccak256(toHex("attest-arc-local"));
const post = (p, body, admin) =>
  fetch(ENGINE_URL + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { "x-admin-key": "dev" } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

console.log("configure", (await post("/configure", { vault, verifier, enclaveId }, true)).body);
const reg = await post("/register", {}, true);
console.log("register", reg.body);
if (!reg.body.ok) throw new Error("register failed");

const vAbi = parseAbi([
  "function isRegistered(bytes32) view returns (bool)",
  "function getEngineAddress(bytes32) view returns (address)",
]);
const tAbi = parseAbi([
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const vaultAbi = parseAbi([
  "function deposit(address,uint256)",
  "function balanceOf(address,address) view returns (uint256)",
]);
const engineAddr = privateKeyToAccount(KEYS[1]).address;
const onchainEngine = await pub.readContract({ address: verifier, abi: vAbi, functionName: "getEngineAddress", args: [enclaveId] });
if (onchainEngine !== engineAddr) throw new Error(`engine mismatch ${onchainEngine}`);

// A replay of the engine's own registration quote from another account must fail.
const replay = await fetch(`${ENGINE_URL}/attestation`).then((r) => r.json());
try {
  await pub.simulateContract({
    account: privateKeyToAccount(KEYS[2]),
    address: verifier,
    abi: parseAbi(["function registerVerifiedEnclave(bytes32,bytes,bytes32,bytes32)"]),
    functionName: "registerVerifiedEnclave",
    args: [enclaveId, replay.parsed.payload, replay.parsed.r, replay.parsed.s],
  });
  throw new Error("replayed registration was accepted");
} catch (e) {
  if (String(e.message).includes("was accepted")) throw e;
  console.log("replayed registration rejected:", e.shortMessage || e.message.split("\n")[0]);
}

async function fund(key, token, amount) {
  const w = wallet(key);
  const me = w.account.address;
  for (const [address, functionName, args] of [
    [token, "mint", [me, amount]],
    [token, "approve", [vault, amount]],
  ]) {
    await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi: tAbi, functionName, args }) });
  }
  await pub.waitForTransactionReceipt({
    hash: await w.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [token, amount] }),
  });
}
const alice = privateKeyToAccount(KEYS[2]);
const bob = privateKeyToAccount(KEYS[3]);
await fund(KEYS[2], usdc, 116_000000n);
await fund(KEYS[3], eurc, 100_000000n);

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
const domain = { name: "Attest", version: "1", chainId: 31337, verifyingContract: vault };
async function signed(acct, giveToken, giveAmount, wantToken, wantAmount) {
  const message = { party: acct.address, giveToken, giveAmount, wantToken, wantAmount, ts: BigInt(Date.now()), enclaveId };
  const signature = await acct.signTypedData({ domain, types, primaryType: "Order", message });
  const order = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { order, signature };
}

const forged = await signed(alice, usdc, 116_000000n, eurc, 100_000000n);
forged.order.wantAmount = "1";
console.log("tampered order ->", (await post("/orders", forged)).status);

console.log("alice order", (await post("/orders", await signed(alice, usdc, 116_000000n, eurc, 100_000000n))).body.order);
const res = await post("/orders", await signed(bob, eurc, 100_000000n, usdc, 115_000000n));
console.log("bob order", res.body);
if (!res.body.settled) throw new Error("no settlement");

const bal = (t, w) => pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [t, w] });
const result = {
  aliceUsdc: await bal(usdc, alice.address),
  aliceEurc: await bal(eurc, alice.address),
  bobUsdc: await bal(usdc, bob.address),
  bobEurc: await bal(eurc, bob.address),
};
console.log(result);
// Bob's order arrived second, so it takes Alice's resting price: 116 USDC for 100 EURC.
const ok = result.aliceUsdc === 0n && result.aliceEurc === 100_000000n && result.bobUsdc === 116_000000n && result.bobEurc === 0n;
console.log(ok ? "E2E PASS" : "E2E FAIL");
cleanup();
process.exit(ok ? 0 : 1);
