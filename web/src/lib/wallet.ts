import { createWalletClient, custom, type EIP1193Provider, type WalletClient } from "viem";
import { arc, CHAIN_ID, RPC_URL, EXPLORER_URL } from "./config";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

function provider(): EIP1193Provider {
  if (!window.ethereum) throw new Error("No EVM wallet found. Install MetaMask or Rabby.");
  return window.ethereum;
}

/** The connected account if this site is already approved, else null. Never prompts. */
export async function getAllowedAddress(): Promise<`0x${string}` | null> {
  if (!window.ethereum) return null;
  try {
    const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as `0x${string}`[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export async function connectWallet(): Promise<`0x${string}`> {
  const accounts = (await provider().request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  if (!accounts[0]) throw new Error("Wallet returned no account");
  await ensureArc();
  return accounts[0];
}

/** Switches the wallet to Arc, adding the network first if it doesn't know it. */
export async function ensureArc() {
  const p = provider();
  const hexId = `0x${CHAIN_ID.toString(16)}`;
  const current = (await p.request({ method: "eth_chainId" })) as string;
  if (parseInt(current, 16) === CHAIN_ID) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: arc.name,
          nativeCurrency: arc.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER_URL],
        },
      ],
    });
  }
}

export async function walletClient(account: `0x${string}`): Promise<WalletClient> {
  await ensureArc();
  return createWalletClient({ account, chain: arc, transport: custom(provider()) });
}

export function onAccountsChanged(cb: (a: `0x${string}` | null) => void): () => void {
  const eth = window.ethereum;
  if (!eth?.on) return () => {};
  const handler = (accounts: unknown) => cb(((accounts as string[])[0] as `0x${string}`) ?? null);
  eth.on("accountsChanged", handler as never);
  return () => eth.removeListener?.("accountsChanged", handler as never);
}
