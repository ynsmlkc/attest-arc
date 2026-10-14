import { createPublicClient, http, parseAbi, maxUint256 } from "viem";
import { arc, ATTESTATION_VERIFIER_ID, RPC_URL, SETTLEMENT_VAULT_ID, type TokenInfo } from "./config";
import { walletClient } from "./wallet";

export const publicClient = createPublicClient({ chain: arc, transport: http(RPC_URL) });

const vaultAbi = parseAbi([
  "function balanceOf(address token, address owner) view returns (uint256)",
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
]);
const verifierAbi = parseAbi([
  "function isRegistered(bytes32 enclaveId) view returns (bool)",
  "function getEnclave(bytes32 enclaveId) view returns (address engine, uint64 verifiedAt)",
  "function mrtdHead() view returns (bytes32)",
  "function mrtdTail() view returns (bytes16)",
  "function rtmr3Head() view returns (bytes32)",
  "function rtmr3Tail() view returns (bytes16)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export async function getVaultBalance(token: TokenInfo, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: SETTLEMENT_VAULT_ID, abi: vaultAbi, functionName: "balanceOf", args: [token.address, owner] });
}

export async function getWalletBalance(token: TokenInfo, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

async function send(owner: `0x${string}`, request: Parameters<typeof publicClient.simulateContract>[0]) {
  const { request: req } = await publicClient.simulateContract({ ...request, account: owner });
  const wallet = await walletClient(owner);
  const hash = await wallet.writeContract(req as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
}

/** Approves the vault if needed, then deposits. Returns the deposit tx hash. */
export async function deposit(token: TokenInfo, owner: `0x${string}`, amount: bigint) {
  const allowance = await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, SETTLEMENT_VAULT_ID],
  });
  if (allowance < amount) {
    await send(owner, { address: token.address, abi: erc20Abi, functionName: "approve", args: [SETTLEMENT_VAULT_ID, maxUint256] });
  }
  return send(owner, { address: SETTLEMENT_VAULT_ID, abi: vaultAbi, functionName: "deposit", args: [token.address, amount] });
}

export async function withdraw(token: TokenInfo, owner: `0x${string}`, amount: bigint) {
  return send(owner, { address: SETTLEMENT_VAULT_ID, abi: vaultAbi, functionName: "withdraw", args: [token.address, amount] });
}

export async function isEnclaveRegistered(enclaveId: `0x${string}`): Promise<boolean> {
  return publicClient.readContract({ address: ATTESTATION_VERIFIER_ID, abi: verifierAbi, functionName: "isRegistered", args: [enclaveId] });
}

export async function getEnclave(enclaveId: `0x${string}`): Promise<{ engine: `0x${string}`; verifiedAt: number } | null> {
  const [engine, verifiedAt] = await publicClient.readContract({
    address: ATTESTATION_VERIFIER_ID,
    abi: verifierAbi,
    functionName: "getEnclave",
    args: [enclaveId],
  });
  return /^0x0{40}$/i.test(engine) ? null : { engine, verifiedAt: Number(verifiedAt) };
}

export async function getEngineAddress(enclaveId: `0x${string}`): Promise<string | null> {
  return (await getEnclave(enclaveId))?.engine ?? null;
}

/** The measurements the verifier is pinned to (48 bytes each, hex). */
export async function getPinnedMeasurements(): Promise<{ mrtd: string; rtmr3: string }> {
  const read = (functionName: "mrtdHead" | "mrtdTail" | "rtmr3Head" | "rtmr3Tail") =>
    publicClient.readContract({ address: ATTESTATION_VERIFIER_ID, abi: verifierAbi, functionName }) as Promise<string>;
  const [mh, mt, rh, rt] = await Promise.all([read("mrtdHead"), read("mrtdTail"), read("rtmr3Head"), read("rtmr3Tail")]);
  return { mrtd: mh + mt.slice(2), rtmr3: rh + rt.slice(2) };
}

const keyAbi = parseAbi(["function attestationKeyX() view returns (bytes32)", "function attestationKeyY() view returns (bytes32)"]);

export interface LiveQuoteCheck {
  challengeBound: boolean;
  signatureValid: boolean;
  mrtdMatches: boolean;
  rtmr3Matches: boolean;
}

/**
 * Asks the engine for a fresh TDX quote over a random challenge and checks it
 * here, against on-chain state only: REPORT_DATA carries the challenge (so the
 * quote is fresh, not replayed), the signature verifies under the verifier's
 * pinned attestation key through Arc's P256VERIFY precompile (0x100, via
 * eth_call), and MRTD/RTMR3 equal the verifier's pinned values.
 */
export async function verifyLiveQuote(
  fetchQuote: (challenge: string) => Promise<{ parsed: { payload?: string; r?: string; s?: string; mrtd: string; rtmr3: string; reportData: string } }>,
): Promise<LiveQuoteCheck> {
  const challenge = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const [{ parsed: q }, pinned, keyX, keyY] = await Promise.all([
    fetchQuote(challenge),
    getPinnedMeasurements(),
    publicClient.readContract({ address: ATTESTATION_VERIFIER_ID, abi: keyAbi, functionName: "attestationKeyX" }),
    publicClient.readContract({ address: ATTESTATION_VERIFIER_ID, abi: keyAbi, functionName: "attestationKeyY" }),
  ]);
  let signatureValid = false;
  if (q.payload && q.r && q.s) {
    const bytes = Uint8Array.from(q.payload.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    const data = `0x${hex}${q.r.slice(2)}${q.s.slice(2)}${keyX.slice(2)}${keyY.slice(2)}` as `0x${string}`;
    const out = await publicClient.call({ to: "0x0000000000000000000000000000000000000100", data });
    signatureValid = BigInt(out.data ?? "0x0") === 1n;
  }
  return {
    challengeBound: q.reportData.slice(0, 66).toLowerCase() === challenge.toLowerCase(),
    signatureValid,
    mrtdMatches: q.mrtd.toLowerCase() === pinned.mrtd.toLowerCase(),
    rtmr3Matches: q.rtmr3.toLowerCase() === pinned.rtmr3.toLowerCase(),
  };
}
