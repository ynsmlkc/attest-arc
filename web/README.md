# Attest on Arc: web

Trading UI for the dark pool (Vite + React + Tailwind + viem).

- **Wallet**: any EIP-1193 wallet (MetaMask, Rabby). Connecting adds/switches
  to Arc mainnet (chain id 5042).
- **Trade**: deposit USDC/EURC into the vault, sign an order as EIP-712 typed
  data, send it to the engine. The engine settles matches on-chain; the vault
  re-checks every signature, size and limit price.
- **Reference price**: the ECB's daily EUR/USD fixing (via Frankfurter), used
  for the chart and to suggest a counter amount. Never enforced; your signed
  limit price is.
- **Attestations**: reads the verifier contract directly, and *Challenge the
  enclave* asks the engine for a fresh TDX quote over a random value, then
  checks it in the browser: the challenge is in REPORT_DATA, the signature
  verifies under the verifier's pinned key through Arc's P256VERIFY precompile
  (an `eth_call` to `0x100`), and MRTD/RTMR3 equal the pinned values.

`src/lib/config.ts` holds every address; each can be overridden with a
`VITE_*` variable (see `.env.example`).

```bash
npm ci
npm run dev
npm run build
```
