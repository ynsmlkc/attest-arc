import { CHAIN_ID, MATCHING_ENGINE_ENCLAVE_ID, SETTLEMENT_VAULT_ID } from "./config";
import { walletClient } from "./wallet";

/**
 * EIP-712 order signing. The wallet shows the order as structured fields, and
 * SettlementVault re-derives the same digest on-chain (ORDER_TYPEHASH,
 * EIP712("Attest", "1")), so the engine can only settle what was signed here.
 * The domain binds the signature to this chain and vault, and `enclaveId`
 * binds it to the attested engine. The engine (engine/index.js) and the vault
 * must use these exact types.
 */
export const ORDER_TYPES = {
  Order: [
    { name: "party", type: "address" },
    { name: "giveToken", type: "address" },
    { name: "giveAmount", type: "uint256" },
    { name: "wantToken", type: "address" },
    { name: "wantAmount", type: "uint256" },
    { name: "ts", type: "uint64" },
    { name: "enclaveId", type: "bytes32" },
  ],
} as const;

export interface OrderFields {
  party: `0x${string}`;
  giveToken: `0x${string}`;
  giveAmount: bigint;
  wantToken: `0x${string}`;
  wantAmount: bigint;
}

export interface SignedOrder {
  order: {
    party: string;
    giveToken: string;
    giveAmount: string;
    wantToken: string;
    wantAmount: string;
    ts: string;
    enclaveId: string;
  };
  signature: `0x${string}`;
}

export async function signOrder(o: OrderFields): Promise<SignedOrder> {
  const message = { ...o, ts: BigInt(Date.now()), enclaveId: MATCHING_ENGINE_ENCLAVE_ID };
  const wallet = await walletClient(o.party);
  const signature = await wallet.signTypedData({
    account: o.party,
    domain: { name: "Attest", version: "1", chainId: CHAIN_ID, verifyingContract: SETTLEMENT_VAULT_ID },
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });
  return {
    order: {
      party: o.party,
      giveToken: o.giveToken,
      giveAmount: o.giveAmount.toString(),
      wantToken: o.wantToken,
      wantAmount: o.wantAmount.toString(),
      ts: message.ts.toString(),
      enclaveId: message.enclaveId,
    },
    signature,
  };
}
