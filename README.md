# Attest on Arc

A dark pool for USDC/EURC on [Arc](https://arc.io) whose matching engine runs
inside an Intel TDX enclave, with the enclave's attestation verified **on-chain**.

Orders are private to the engine until they match. The vault only lets the
engine settle if the engine's address was registered by a genuine TDX quote of
the exact pinned code, and every trader's EIP-712 signature, size and limit
price is re-checked on-chain. A compromised engine key still can't move funds
a trader didn't sign for.

This is a port of [Attest](https://github.com/ynsmlkc/attest) (built on Stellar
Soroban) to Arc. Same verification logic and byte offsets; one gap closed that
the Soroban version could not close (see *Registration binding*).

## Live on Arc mainnet

| | |
|---|---|
| App | https://ynsmlkc.github.io/attest-arc/ |
| AttestationVerifier | [`0xf07a39f310aC8617F428d6991749c8eF78725F2F`](https://explorer.arc.io/address/0xf07a39f310aC8617F428d6991749c8eF78725F2F) |
| SettlementVault | [`0x64995506ca26BB0c004d2645F32A8abc8Fc7B1d6`](https://explorer.arc.io/address/0x64995506ca26BB0c004d2645F32A8abc8Fc7B1d6) |
| Engine (key derived in the enclave) | [`0x79b75a479825a55232544916925C7f74bAcc71e6`](https://explorer.arc.io/address/0x79b75a479825a55232544916925C7f74bAcc71e6) |
| Engine CVM | Phala Cloud, Intel TDX, app `5cf5be8156cf176b73375110cf90b7ec691b0bab` |

What happened on mainnet (all transactions on [explorer.arc.io](https://explorer.arc.io)):

1. Verifier deployed pinned to the CVM's own MRTD / RTMR3 / attestation key, read
   from its quote and cross-checked against Phala's reported `tcb_info` (exact match).
2. The engine registered itself: it asked the TDX hardware for a quote whose
   REPORT_DATA binds its address, and submitted it from that address —
   [`0x6e6a4810…f5ba959c`](https://explorer.arc.io/tx/0x6e6a4810026ccb85095fc9d15cd44e9d4c2103cd4ff8947b8a454965f5ba959c).
3. Two wallets deposited, signed opposite EIP-712 orders and sent them to the
   engine; the engine matched them and settled from its enclave key —
   [`0x9b77fe32…0c9bd01e`](https://explorer.arc.io/tx/0x9b77fe32800a6640d813b0e3b562967eba489e944c35303eccc719890c9bd01e).
   A tampered copy of an order was refused (HTTP 401) before reaching the chain.

Full record: [`deployments/arc-mainnet.json`](deployments/arc-mainnet.json). Re-run the
trade with `scripts/demo-trade.mjs`.

## How it works

```
trader wallet ──EIP-712 order──▶ matching engine (Phala TDX CVM)
                                   │  key derived inside the enclave
                                   │  matches orders (price-time, partial fills)
                                   ▼
                     SettlementVault.settle(enclaveId, orderA, sigA, fillA, orderB, sigB, fillB)
                                   │  msg.sender == verifier.getEngineAddress(enclaveId)?
                                   │  each order signed by its party? not overfilled? at/above limit?
                                   ▼
                     internal balances swap atomically (USDC ⇄ EURC)

AttestationVerifier.registerVerifiedEnclave(enclaveId, quotePayload, r, s)
   • ECDSA P-256 signature over SHA-256(payload) — Arc's P256VERIFY precompile (EIP-7951, 0x100)
   • MRTD   (payload 184..232) == pinned  → genuine TDX + dstack firmware
   • RTMR3  (payload 520..568) == pinned  → this exact app compose (and so this exact engine code)
   • REPORT_DATA[0..32]        == keccak256("attest-arc:register:v1", chainid, verifier, enclaveId, msg.sender)
```

### Registration binding (new on Arc)

The engine asks the TDX hardware for a quote whose `REPORT_DATA` commits to the
address it is registering, on this chain and this verifier. The verifier only
accepts the quote from that address. A quote that is public on-chain can't be
replayed by anyone else, or on another chain or verifier. The Soroban version
documented first-registration front-running as a residual gap; this closes it.

### What is measured

The engine is bundled into one file (`engine/dist/engine.mjs`, all dependencies
inlined). The CVM's compose runs the official `node:22-alpine` image pinned by
digest, downloads that file from this repo at a fixed commit and refuses to
start unless its sha256 matches the one written in the compose. RTMR3 covers
the whole compose, so the on-chain RTMR3 pins the exact engine bytes. Rebuild
with `cd engine && npm ci && npm run bundle` and compare.

## Repo layout

```
contracts/   Foundry: AttestationVerifier.sol, SettlementVault.sol, tests, deploy script
engine/      matching engine (Node, viem); dev.js runs it locally with synthetic quotes
web/         trading UI (Vite + React + viem)
scripts/     e2e-local.mjs: full register → order → settle run on a local anvil chain
             demo-trade.mjs: the same trade against the live mainnet deployment
deployments/ addresses, measurements and transactions of the mainnet deployment
```

## Tests

```bash
cd contracts && forge test           # 24 tests, incl. a real Intel-signed TDX quote
cd engine && npm ci && npm test      # matcher unit tests
node scripts/e2e-local.mjs           # whole flow on anvil (needs foundry)
```

The verifier was also checked against Arc mainnet directly: the real
Intel-signed quote from Automata's public TDX test vector verifies through
Arc's P256VERIFY precompile, and a one-bit-tampered payload is rejected.

## Scope and limits

- The attestation key is pinned at deploy (same scope as the Soroban version);
  the full PCK certificate chain up to Intel's root CA is not verified on-chain.
- The engine's book is in memory. Orders not yet matched are lost on restart
  (funds are not: they stay in the vault and can be withdrawn at any time).
- Deposits and withdrawals are public on-chain; order flow is not.
