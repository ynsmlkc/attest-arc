import { MATCHING_ENGINE_URL } from "./config";
import type { SignedOrder } from "./orderSigning";

export interface Order {
  id: number;
  party: string;
  giveToken: string;
  giveAmount: number;
  wantToken: string;
  wantAmount: number;
  createdAt?: string;
  /** Unfilled part of `giveAmount`. */
  remaining?: number;
}

export interface Match {
  orderAId: number;
  orderBId: number | null;
  txHash: string | null;
  at: string;
  partyA?: string;
  partyB?: string | null;
  giveTokenA?: string;
  giveAmountA?: string;
  giveTokenB?: string;
  giveAmountB?: string | null;
}

export interface EngineAttestation {
  ok: boolean;
  quote: string;
  parsed: { payload: string; r: string; s: string; mrtd: string; rtmr3: string; reportData: string; keyX: string; keyY: string };
  txHash?: string;
  at?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MATCHING_ENGINE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? body?.settleError ?? `matching-engine ${path} -> ${res.status}`);
  return body as T;
}

export function engineHealth() {
  return api<{ ok: boolean }>("/health");
}

export function submitOrder(signed: SignedOrder) {
  return api<{ ok: boolean; order: Order; settled: Match | null; fills?: Match[]; settleError?: string }>("/orders", {
    method: "POST",
    body: JSON.stringify(signed),
  });
}

export function listOrders() {
  return api<{ orders: Order[] }>("/orders");
}

export function listMatches() {
  return api<{ matches: Match[] }>("/matches");
}

/** The quote the engine registered with (or a fresh one over `challenge`). */
export function engineAttestation(challenge?: string) {
  return api<EngineAttestation>(`/attestation${challenge ? `?challenge=${challenge}` : ""}`);
}
