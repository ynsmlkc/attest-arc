import { defineChain } from "viem";

// Arc mainnet. Every deployment value can be overridden per environment with
// VITE_* variables (see web/.env.example), e.g. to point a dev server at a
// local anvil chain and a dev engine.
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 5042);
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://rpc.mainnet.arc.io";
export const EXPLORER_URL = import.meta.env.VITE_EXPLORER_URL ?? "https://explorer.arc.io";

export const arc = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 5042 ? "Arc" : `Arc (${CHAIN_ID})`,
  // Native USDC is 18 decimals; the ERC-20 interface the vault uses is 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER_URL } },
});

/** SettlementVault: settle() only accepts the engine the verifier registered. */
export const SETTLEMENT_VAULT_ID = (import.meta.env.VITE_VAULT_ID ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
/** AttestationVerifier: pinned to the engine CVM's MRTD, RTMR3 and attestation key. */
export const ATTESTATION_VERIFIER_ID = (import.meta.env.VITE_VERIFIER_ID ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
export const MATCHING_ENGINE_ENCLAVE_ID = (import.meta.env.VITE_ENCLAVE_ID ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;
/** The address the engine derives inside the TDX enclave (dstack GetKey). */
export const MATCHING_ENGINE_ENGINE_ADDRESS = (import.meta.env.VITE_ENGINE_ADDRESS ??
  "0x79b75a479825a55232544916925C7f74bAcc71e6") as `0x${string}`;
/** The engine CVM's HTTP API, through Phala's gateway. */
export const MATCHING_ENGINE_URL =
  import.meta.env.VITE_ENGINE_URL ?? "https://5cf5be8156cf176b73375110cf90b7ec691b0bab-80.dstack-pha-prod5.phala.network";

export interface TokenInfo {
  code: string;
  name: string;
  /** ERC-20 address on Arc. */
  address: `0x${string}`;
  decimals: number;
  logo: string;
  /** Accent used for this token's monogram ring when `logo` fails to load. */
  tone: string;
}

// Circle's own stablecoins on Arc (docs.arc.io contract addresses). USDC here
// is the optional ERC-20 interface over the native balance (6 decimals).
export const USDC: TokenInfo = {
  code: "USDC",
  name: "USD Coin",
  address: (import.meta.env.VITE_USDC ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
  decimals: 6,
  logo: `${import.meta.env.BASE_URL}tokens/usdc.png`,
  tone: "#5B8DB8",
};

export const EURC: TokenInfo = {
  code: "EURC",
  name: "Euro Coin",
  address: (import.meta.env.VITE_EURC ?? "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1") as `0x${string}`,
  decimals: 6,
  logo: `${import.meta.env.BASE_URL}tokens/eurc.png`,
  tone: "#2F6FB0",
};

export const TRADABLE_TOKENS: TokenInfo[] = [EURC, USDC];

export function tokenByAddress(address: string): TokenInfo | undefined {
  return TRADABLE_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER_URL}/address/${a}`;

export const REPO_URL = import.meta.env.VITE_REPO_URL ?? "https://github.com/ynsmlkc/attest-arc";
