# Escrow Contract Bindings (Option C / P2.4 ADR 0002)

TypeScript bindings for TrustGate's `Escrow` Soroban contract.

⚠️ **CURRENT STATE (2026-08-05):** Bindings created MANUALLY because the Rust 1.84.0 toolchain (frozen version for the 2 Registry + Escrow contracts) has not yet been installed in the local developer environment (see
`scripts/contract-security-check.sh` — today it returns `RC=77` for missing toolchain).

## Regeneration (after P0-5 = real deploy of compiled WASM)

When `rustup 1.84.0` is installed:

```bash
# 1. Generate the wasm
cd ../../../../contracts/escrow
rustup override set 1.84.0
cargo build --target wasm32-unknown-unknown --release
# 2. Generate auto bindings (replaces THIS entire directory):
soroban contract bindings typescript \
  --output-dir ../../../src/contracts/bindings/escrow/ \
  --wasm target/wasm32-unknown-unknown/release/trustgate_escrow_contract.wasm
```

## UPDATE NOTE 2026-08-06 (V14 marketplace-aligned bindings)
The manual `src/client.ts` file has been ALIGNED with `contracts/escrow/src/lib.rs fn initialize(token, release_signer, marketplace)`:
  - ✅ **BEFORE (wrong V13-):** `initialize(token, release_signer, pauser?)`
  - ✅ **NOW (correct V14+):** `initialize(token, release_signer, marketplace)` (3rd arg mandatory)
When regenerating auto bindings via soroban CLI, VALIDATE that the new interface
keeps the names above. `marketplace` is authorized in `confiscate()` via
`DataKey::Marketplace`; if regeneration reverts to `pauser`, **the entire
`release_signer.require_auth()` → `DataKey::Marketplace` chain will break.**

## Build

```bash
npm install
npm run build
```

## Usage (same as registry bindings)

```typescript
import { Client } from "./src";

const escrow = new Client({
  contractId: process.env.ESCROW_CONTRACT_ID!,
  rpcUrl: process.env.STELLAR_RPC_URL!,
  networkPassphrase:
    process.env.NETWORK === 'testnet'
      ? "Test SDF Network ; September 2015"
      : "Standalone Network ; February 2024",
});

// Example: escrow creation via AssembledTransaction (before submitTx):
const tx = await escrow.create_escrow({
  executor: "G...",
  task_id_hash: Buffer.from(taskSha256Hex, 'hex'),     // BytesN<32>
  release_signer: "G...",                               // = Authorized Marketplace
  requester: "G...",
  token: "C...USDC...",                                 // USDC contract ID
  collateral_amount: 5_000_000n,
}, {
  simulate: true,
  signAndSubmit: false, // Signature and submit are the responsibility of the upper layer
                        // (Backend Worker OurOwnEscrowContractClient implements).
});
```

## Security changelog (vs initial Rust contract version)

The bindings in this folder ALWAYS reflect the Rust API in contracts/escrow/src/lib.rs,
including the P0 fixes applied on 2026-08-05:

- ✅ P0-2: `claim_timeout` transfers collateral 100% TO EXECUTOR after 14 days.
- ✅ P0-3: `confiscate` validates param `marketplace === ReleaseSigner` on storage.
- ✅ P0-6: `claim_timeout` is permissionless (any address can call after 14d).
- ✅ P0-7: `confiscate` requester_share_bp MINIMUM = 3000 (30%)
