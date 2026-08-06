# ADR 0002: On-chain strategy — Registry Soroban Immutable + Escrow via third-party SaaS (Trustless Work)

## Status
- Accepted
- Date: 2026-08-05
- Implementation (2026-08-05 update): **5/6 pillars with a foundation coded in src/ (P1.8A + P2.1 + P2.4 Option C)**
  - ✅ Off-chain emergency pauses: `PAUSE_NEW_TASKS`, `PAUSE_NEW_BIDS`, `PAUSE_WORKER_CONSUMPTION` (3 env vars parsed in `src/config/safetyFeatures.ts`)
  - ✅ Off-chain executor allowlist/denylist: `EXECUTOR_DENYLIST` (CSV of Stellar G… addresses, validated with the regex `^G[A-Z2-7]{55}$`, enforced in `BidController.create` + `TaskController.complete`)
  - ✅ `IProviderEscrow` abstraction + `createEscrowProvider()` factory + `ESCROW_IMPLEMENTATION=trustlesswork|mock|ourown` (the type was previously called `EscrowServiceLike`; a deprecated alias is kept for backwards compatibility). The factory validates 4 P0 blockers before returning the `ourown` implementation.
  - ✅ **Foundation** Escrow SaaS webhook verification public key: `TRUSTLESS_WORK_WEBHOOK_PUBLIC_KEY` (parsed in safetyFeatures, `len >= 32` validation, exported via `SafetyFeatures.trustlessWorkWebhookPublicKey`, logged at boot as a `sha256[:8]` preview with no leak). The `POST /webhooks/trustless-work` endpoint + Ed25519/SPKI signature middleware are still **pending P2.2** (there is no request contract on the Trustless Work side yet to design the middleware against).
  - ✅ **Native Escrow contract, Option C (Golden Path):** `contracts/escrow/Cargo.toml` + `src/lib.rs` (Soroban SDK 22.0.1, Rust 1.84, 4 methods + 6 unit tests). Methods: `create_escrow` (CEI + executor.require_auth + save state + transfer USDC), `release_milestone` (release_signer.require_auth), `confiscate` (requester.require_auth + split_bp + requester/marketplace share), `claim_timeout` (permissionless after 14d of ledger → 100% to the requester). **⚠️  P4 today: it is NOT activatable in production right now.** 4 P0 blockers remain: (a) compiled WASM + deploy on testnet/pubnet (the `scripts/deploy-registry.ts` template exists); (b) 2 published independent audits (escrow = Top 5 DeFi attack surface); (c) TypeScript bindings generated in `src/contracts/bindings/escrow/` (mirroring the registry bindings); (d) `OurOwnEscrowContractClientStub` replaced by a real implementation that calls the bindings via Soroban RPC. Today the factory returns a SAFE STUB that throws on all 3 methods (`createEscrow`/`releaseMilestone`/`confiscate`) with a detailed blocker message if activated prematurely.
  - ⏳ Blue-green dual registry reads (v1 + v2 at the same time for 7 days): pending until a v2 exists to migrate to

## Context
- TrustGate interacts with the Stellar blockchain (Soroban + Classic + MPP) at two central points that require a trade-off between simplicity, security and room to evolve:
  1. **Executor Registry** — the Soroban `RegistryContract` in [contracts/registry/src/lib.rs](../../contracts/registry/src/lib.rs) which stores `(executor Address → ExecutorInfo { metadata_uri })` and exposes 3 functions: `register_executor`, `is_registered`, `get_executor`. Only the executor authenticates via `require_auth()` on write; there is no admin role in the contract.
  2. **Escrow collateral and milestones** (executor deposit on bid, release by the marketplace when a task is completed, dispute, milestone rollback). TrustGate does **NOT** implement the escrow contract on-chain — it consumes the REST API from [escrowService.ts](../../src/services/escrowService.ts) via `@stellar-agent-kit/plugin-trustless-work` (a SaaS provider client).
- Deploying the Registry via [scripts/deploy-registry.ts](../../scripts/deploy-registry.ts) publishes the WASM and returns the `REGISTRY_CONTRACT_ID` as a string. The script does **not** implement any upgrade function (`update_current_contract_wasm`, `set_contract_instance_v2`, etc.) nor expose any `upgrade(address executor)` method.
- The architectural options considered depend on the trade-off:
  - **Upgradeable Registry:** shorter time to deploy an on-chain patch, but a gas cost from the extra storage for the upgrade function + a larger attack surface (the upgrade admin key becomes a target).
  - **Our-own Escrow Contract:** full control over pause/unpause, upgrade and platform fees, but mandatory external audit (several weeks), legal implications (we become indirect custodians), and continuous maintenance of a contract in production (on-chain bug rollbacks are expensive on Stellar Soroban).

## Decision
Adopt **two separate strategies** (separation of concerns), each aligned to the risk of its component:

1. **Registry Soroban Immutable (non-upgradeable):**
   - Keep `RegistryContract` with 3 functions only and no WASM upgrade method in the contract.
   - **Deploy roadmap for evolution:** blue-green via the `REGISTRY_CONTRACT_ID` env var:
     1. Deploy the new WASM (v2, v3, …) → new contract address `C2`.
     2. Migrate active executors (off-chain, by the marketplace): `POST /executors/register` pointing at `C2` (each executor authenticates with `require_auth()` individually on the new contract — no global admin key performs a forced migration).
     3. A grace period of ~7 days (configurable by feature flag) during which the App reads from **both contracts** (old + new) in the `is_registered` check, so executors that have not re-registered yet are not broken.
     4. At the end of the period, `REGISTRY_CONTRACT_ID` is switched from `C1` → `C2` and reads from `C1` are turned off.
   - **TTL:** instance TTL extended to `518_400` blocks (~30 days at 5 s/block) after every write; threshold `100`. Instance storage is cheap on Soroban.
   - **Pattern:** "Non-upgradeable contract + data layer off-chain orchestration" (no upgrade is needed in the contract code because the migration layer is the off-chain API).

2. **Bid/milestone escrow via Trustless Work SaaS (third party):**
   - Keep [escrowService.ts](../../src/services/escrowService.ts) as a REST wrapper over `@stellar-agent-kit/plugin-trustless-work`, with roles:
     - `serviceProvider` = our `MARKETPLACE_WALLET.publicKey`
     - `releaseSigner` = our `MARKETPLACE_WALLET.publicKey` (offline signature with a key kept in a Vault/secret env)
     - `approver` / `disputeResolver` = our `MARKETPLACE_WALLET.publicKey`
   - **Escrow contract pause / upgrade / security:** explicitly the responsibility of the Trustless Work SaaS provider. We document the dependency strategy:
     - A contractual commitment (SLA) with the provider covering pause in case of a disclosed vulnerability and a P0 communication channel (24/7).
     - For every release of their escrow contract the provider delivers: (a) the most recent external audit report (2 independent audits, minimum), (b) a changelog of breaking changes to the `/bid` `/release` `/raiseDispute` endpoints with 30 days of deprecation notice, (c) the public key used to verify API responses, so we can validate the signature on the resolved-dispute webhook.
   - **Provider exit strategy:** we keep the `IProviderEscrow` interface (an abstraction in `EscrowService` with an injectedClient) and have a blueprint for `OurOwnEscrowContractClient` as a fallback implementation — activatable through the `ESCROW_IMPLEMENTATION=trustlesswork|ourown` env var without rewriting business rules in `bidController` / `taskController`.

3. **No global "on-chain pause" feature flag in TrustGate itself:** emergency pauses (e.g. freezing new bids / new tasks) happen through:
   - the `paused()` logic of the Trustless Work SaaS provider, for escrow;
   - the `PAUSE_NEW_TASKS`, `PAUSE_NEW_BIDS`, `PAUSE_WORKER_CONSUMPTION` off-chain feature flags in the App (3 env vars, candidates to enable during a P0 incident) which block mutations without affecting reads and without requiring an on-chain transaction.

## Consequences
- Pros
  - **Registry:** lower gas cost per deploy and per invocation (no `admin`/upgrade role check on write, no extra storage for `current_wasm_hash`); faster sign-off from external contract auditors thanks to a minimal attack surface (3 functions only).
  - **Registry:** no single-point-of-failure key (an "admin upgrade key") in the deploy secrets. Each executor controls its own re-registration via `require_auth()` = a **non-custodial pattern**.
  - **Escrow SaaS:** zero effort auditing an on-chain contract of our own; an escrow contract bug (reentrancy vulnerability / bad math) is the vendor's responsibility, under SLA.
  - **Escrow SaaS:** our team stays focused on marketplace business rules (tasks/bids/auction/webhooks/outbox) instead of the cryptographic engineering details of atomic payment.
  - **Emergency pauses via off-chain feature flag:** mitigation deploys in minutes, not hours; no on-chain multisig coordination required.
- Cons
  - **Registry:** rolling out a breaking change to the Registry schema (e.g. adding a `reputation_score` or `capabilities` field to `ExecutorInfo`) requires deploying a new contract + a 7-day grace period → ~1–2 weeks of operational overhead per schema release (there is no "hot upgrade").
  - **Registry:** inactive executors that do not re-register on the new contract within the grace period disappear from the registry (an acceptable trade-off, since the marketplace can notify executors by email/webhook).
  - **Escrow SaaS:** partial vendor lock-in. Moving to another vendor or to "our own contract" requires rewriting the `IProviderEscrow` implementation (estimated effort ~8 SP). Webhook payloads and escrow state belong to the vendor; our copy lives in Postgres via `bids.escrow_id` + outbox events for auditing.
  - **Escrow SaaS:** on-chain contract bugs on the vendor's side have no fast patch on our side; we have to wait for the vendor's release. Mitigation: SLA + off-chain pause of new bids via feature flag.
  - **Both:** there is no on-chain pause in the Registry (since `executor.require_auth()` validates and writes, there is no "unregister"). Mitigation: off-chain allowlist (`EXECUTOR_ALLOWLIST_DISABLE=false`) and the emergency `EXECUTOR_DENYLIST` env var (blocks `registerBid` and `POST /tasks/:id/complete` for deny-listed keys without requiring an on-chain transaction).

## Additional operational trade-offs (2026-08-05 update)

### Registry blue-green migration table (example v1 → v2)

| Phase | Duration (e.g.) | REGISTRY_CONTRACT_ID env | Executor reads | Re-registration |
|-------|-----------------|---------------------------|----------------|-----------------|
| 1 | Day 0 | `C1` (old) | `C1` only | Nobody |
| 2 | Deploy `C2` + grace period starts (7 days) | `C1` (still) | Dual read `C1 \|\| C2` in `is_executor_registered` | Executors re-register through the API (marketplace UI button "Update registry for v2") → each one calls `require_auth()` on `C2` |
| 3 | End of the grace period (day 7) | `C2` (new) | `C2` only | Closed. Executors that did not migrate = implicitly removed from the registry (they can reactivate at any time by re-registering). |

Rolling this migration back is trivial: if `C2` shows unexpected behaviour in phase 2, point `REGISTRY_CONTRACT_ID` back at `C1` (~1 min) and turn off the dual read. No on-chain transaction is reverted.

### Contractual obligations with the Escrow SaaS vendor (minimum checklist)

| Item | Mandatory? | Why |
|------|------------|-----|
| 2 published independent external audits of their escrow contract | ✅ Yes | Without this = P0 pubnet blocker. |
| 99.9% uptime SLA + 24/7 P0 channel for discovered on-chain vulnerabilities | ✅ Yes | An escrow bug = loss of executor funds. |
| Webhook verification public key (HMAC or Ed25519) to validate resolved-dispute calls | ✅ Yes | Prevents a spoofed "dispute won" webhook in favour of a fraudulent executor. |
| 30-day deprecation notice + semantic changelog on API releases | ✅ Yes | Avoids silent integration regressions. |
| Documentation of `pause/unpause` and its activation SLO in production | ✅ Yes | The P0 incident plan depends on it. |
| Vendor publishes the escrow contract address and its verified source (Soroban verified WASM hash) | ✅ Yes | Transparency, so we can independently audit whether the `plugin-trustless-work` library calls the expected address. |

### Vendor exit strategy — the "15 days without the vendor" plan:

1. Build `OurOwnEscrowContractClient implements IProviderEscrow` (~8 SP) with our own contract (Soroban WASM) + deploy.
2. Migrate active bids: executors re-create bids and collateral on the new contract. Tasks with an accepted but uncompleted bid → an off-chain per-task `MIGRATE_ESCROW_TYPE` option.
3. Switch the `ESCROW_IMPLEMENTATION=ourown` env var in a rolling deploy.

## Alternatives considered
- **Upgradeable Registry via admin key + `update_current_contract_wasm`**
  - Rejected: shorter patch time, but it adds an `admin` role = single point of failure. On Stellar Soroban, an "admin key" for a public registry contract is an obvious target; the security of the whole marketplace would depend on whoever custodies that key (on-chain multisig or KMS). The blue-green approach via env var is less elegant but safer for an MVP on pubnet.
- **Implementing our own Escrow contract (Soroban) instead of using the Trustless Work SaaS**
  - Rejected: prohibitive cost in audit effort (escrow = Top 5 attackable in DeFi) + fiduciary responsibility. We use the Trustless Work SaaS (which is already audited) for escrow, and keep the `IProviderEscrow` interface for the exit strategy. MVP first, then consider our own contract when volume justifies it.
- **On-chain pause (Pauseable extension) in the Registry itself**
  - Rejected: cost/complexity for little benefit. Pausing executor *registrations* does not answer any real MVP incident; the attack vector is malicious executors, which we mitigate with the off-chain allowlist/denylist and bid/task validation. A marketplace-level emergency pause is better handled by an off-chain feature flag + a 1-minute redeploy.
