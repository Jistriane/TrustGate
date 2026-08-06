# ADR 0002: On-chain Strategy — Immutable Soroban Registry + Escrow via Third-party SaaS (Trustless Work)

## Status
- Accepted
- Date: 2026-08-05
- Implementation (2026-08-05 update): **5/6 pillars with foundation coded in src/ (P1.8A + P2.1 + P2.4 Option C) + Incident Runbook v1.0 complete in docs/incident-response-runbook.md (P1-C)**
  - ✅ Emergency off-chain pauses: `PAUSE_NEW_TASKS`, `PAUSE_NEW_BIDS`, `PAUSE_WORKER_CONSUMPTION` (3 env vars parsed in `src/config/safetyFeatures.ts`). Step-by-step activation/deactivation playbook documented in Runbook §3 and §4.
  - ✅ Off-chain executor Allowlist/Denylist: `EXECUTOR_DENYLIST` (CSV Stellar G…, validated with regex `^G[A-Z2-7]{55}$`, applied in `BidController.create` + `TaskController.complete`)
  - ✅ `IProviderEscrow` abstraction + `createEscrowProvider()` factory + `ESCROW_IMPLEMENTATION=trustlesswork|mock|ourown` (previously called type `EscrowServiceLike`; we keep deprecated alias for backward compatibility). Factory validates 4 P0 blockers before returning `ourown` implementation.
  - ✅ **Foundation** SaaS Escrow webhook verification public key: `TRUSTLESS_WORK_WEBHOOK_PUBLIC_KEY` (parsed in safetyFeatures, validation `len >= 32`, export via `SafetyFeatures.trustlessWorkWebhookPublicKey`, boot log via `sha256[:8]` preview without leak). Endpoint `POST /webhooks/trustless-work` + Ed25519/SPKI signature middleware still **pending P2.2** (no request contract on the Trustless Work side to design middleware yet).
  - ✅ **Native Escrow Contract Option C (Golden Path):** `contracts/escrow/Cargo.toml` + `src/lib.rs` (Soroban SDK 22.0.1, Rust 1.84, 4 methods + 6 unit tests). Methods: `create_escrow` (CEI + executor.require_auth + save state + transfer USDC), `release_milestone` (release_signer.require_auth), `confiscate` (requester.require_auth + split_bp + requester/marketplace share), `claim_timeout` (permissionless after 14d ledger → 100% to requester). **⚠️  P4 today: CANNOT be activated in production now.** 4 P0 blockers remain: (a) Compiled WASM + deploy on testnet/pubnet (script `scripts/deploy-registry.ts` model exists); (b) 2 independent audits published (escrow = Top 5 DeFi attack surface); (c) TypeScript bindings generated in `src/contracts/bindings/escrow/` (mirroring registry bindings); (d) `OurOwnEscrowContractClientStub` replaced by real implementation that calls bindings via Soroban RPC. Today the factory returns a SAFE STUB that throws an error on all 3 methods (`createEscrow`/`releaseMilestone`/`confiscate`) with a detailed blocker message if activated prematurely.
  - ⏳ Dual registry blue-green read (v1 + v2 simultaneously for 7 days): pending until v2 exists to migrate

## Context
- TrustGate interacts with the Stellar blockchain (Soroban + Classic + MPP) at two central points that require compromise between simplicity, security, and evolution capacity:
  1. **Executor Registry** — Soroban contract `RegistryContract` at [contracts/registry/src/lib.rs](file:///home/jistriane/TrustGate/TrustGate/contracts/registry/src/lib.rs) that stores `(executor Address → ExecutorInfo { metadata_uri })` and exposes 3 functions: `register_executor`, `is_registered`, `get_executor`. Only the executor authenticates via `require_auth()` on write; there is no admin role in the contract.
  2. **Escrow collateral and milestones** (deposit by executor in bid, release by marketplace when task completed, dispute, milestone rollback). TrustGate **DOES NOT** implement the on-chain escrow contract — it consumes the REST API from [escrowService.ts](file:///home/jistriane/TrustGate/TrustGate/src/services/escrowService.ts) via `@stellar-agent-kit/plugin-trustless-work` (SaaS provider client).
- Registry deployment via [scripts/deploy-registry.ts](file:///home/jistriane/TrustGate/TrustGate/scripts/deploy-registry.ts) publishes the WASM and returns the `REGISTRY_CONTRACT_ID` as a string. The script **does not** implement any upgrade function (`update_current_contract_wasm`, `set_contract_instance_v2`, etc.) nor exposes any `upgrade(address executor)` method.
- Considered architectural options depend on the trade-off:
  - **Upgradeable Registry:** shorter on-chain patch deploy time, but gas cost for extra storage of the upgrade function + larger attack surface (upgrade admin key = target).
  - **Our-own Escrow Contract:** full control over pause/unpause, upgrade and platform fees, but mandatory external audit (several weeks), legal implication (we are indirect custodians), and continuous maintenance of contract in production (on-chain bug rollbacks are expensive in Stellar Soroban).

## Decision
Adopt **two separate strategies** (separation of concerns), each aligned with the component's risk:

1. **Immutable Soroban Registry (Non-Upgradeable):**
   - Keep `RegistryContract` with only 3 functions and no WASM upgrade method in the contract.
   - **Deployment roadmap for evolution:** Blue-green via `REGISTRY_CONTRACT_ID` env var:
     1. Deploy new WASM (v2, v3, …) → new contract address `C2`.
     2. Migrate (off-chain, by marketplace) active executors: `POST /executors/register` pointing to `C2` (each executor authenticates `require_auth()` individually in the new contract — no global admin key performs forced migration).
     3. Grace period of ~7 days (configurable via feature flag) where the App reads from **both contracts** (old + new) in `is_registered` check to not break executors that haven't re-registered yet.
     4. At the end of the period, `REGISTRY_CONTRACT_ID` changed from `C1` → `C2`, reading from `C1` turned off.
   - **TTL:** Instance TTL extend to `518_400` blocks (~30 days at 5 s/block) after every write; threshold `100`. Instance storage is cheap in Soroban.
   - **Pattern:** "Non-upgradeable contract + data layer off-chain orchestration" (we don't need upgrade in the contract code because the migration layer is an off-chain API).

2. **Bid/milestone Escrow via Trustless Work SaaS (third-party):**
   - Keep [escrowService.ts](file:///home/jistriane/TrustGate/TrustGate/src/services/escrowService.ts) as a REST wrapper over `@stellar-agent-kit/plugin-trustless-work`, with roles:
     - `serviceProvider` = our `MARKETPLACE_WALLET.publicKey`
     - `releaseSigner` = our `MARKETPLACE_WALLET.publicKey` (offline signature on key stored in Vault/secret env)
     - `approver` / `disputeResolver` = our `MARKETPLACE_WALLET.publicKey`
   - **Pause / Upgrade / Escrow Contract Security:** explicitly the responsibility of Trustless Work SaaS provider. We document the dependency strategy:
     - Contractual commitment (SLA) with provider covering pause in case of disclosed vulnerability and P0 communication channel (24/7).
     - Provider delivers, on each release of their escrow contract: (a) most recent external audit report (2 independent audits, minimum), (b) break-changes changelog on endpoints `/bid` `/release` `/raiseDispute` with 30 days deprecation notice, (c) public key for API response verification to validate signature on resolved dispute webhook.
   - **Provider Exit strategy:** we keep the `IProviderEscrow` interface (abstraction in `EscrowService` with injectedClient) and have a blueprint for `OurOwnEscrowContractClient` as a fallback implementation — activatable via env var `ESCROW_IMPLEMENTATION=trustlesswork|ourown` without rewriting business rules in `bidController` / `taskController`.

3. **No global "pause on-chain" feature flag directly in TrustGate:** emergency pauses (e.g., freeze new bids / new tasks) happen via:
   - `paused()` logic from Trustless Work SaaS provider for escrow;
   - `PAUSE_NEW_TASKS`, `PAUSE_NEW_BIDS`, `PAUSE_WORKER_CONSUMPTION` off-chain feature flags in the App (3 env vars candidates to implement in P0 incident) that block mutations without affecting reads and without requiring on-chain transaction.

## Consequences
- Pros
  - **Registry:** lower gas cost per deploy and per invocation (no `admin`/upgrade role verification on write, no extra storage for `current_wasm_hash`); faster approval by external contract auditors due to minimal attack surface (3 functions only).
  - **Registry:** no single-point-of-failure key ("admin upgrade key") in deploy secret. Each executor controls their own re-registration via `require_auth()` = **non-custodial pattern**.
  - **Escrow SaaS:** zero own-contract on-chain audit effort; escrow contract bugs (reentrancy vulnerability / bad math) are the supplier's responsibility with SLA.
  - **Escrow SaaS:** our team's focus on marketplace business rules (tasks/bids/auction/webhooks/outbox) vs. atomic payment cryptographic engineering details.
  - **Emergency pauses via off-chain feature flag:** mitigation deploy in minutes, not hours; does not require on-chain multisig coordination.
- Cons
  - **Registry:** breaking change rollout in Registry schema (e.g.: add `reputation_score` or `capabilities` field in `ExecutorInfo`) requires new contract deploy + 7-day grace period → ~1–2 weeks of operational overhead per schema release (no "hot upgrade" exists).
  - **Registry:** inactive executors who don't re-register in the new contract during the grace period disappear from the registry (acceptable trade-off as marketplace can notify executors via email/webhook).
  - **Escrow SaaS:** partial vendor lock-in. Exit to another supplier or "our own contract" requires rewriting the `IProviderEscrow` implementation (estimated effort ~8 SP). Webhook payloads and escrow state belong to the supplier; our copy stays in Postgres via `bids.escrow_id` + outbox events for audit.
  - **Escrow SaaS:** supplier's on-chain contract bugs don't have a quick patch on our side; we have to wait for the supplier's release. Mitigation: SLA + off-chain pause of new bids via feature flag.
  - **Both:** Absence of on-chain pause in Registry (once `executor.require_auth()` validates and writes, there's no "unregister"). Mitigation: off-chain allowlist (`EXECUTOR_ALLOWLIST_DISABLE=false`) and emergency `EXECUTOR_DENYLIST` env var (blocks `registerBid` and `POST /tasks/:id/complete` for deny-listed keys without requiring on-chain transaction).

## Additional operational trade-offs (2026-08-05 update)

### Registry blue-green migration table (v1 → v2 example)

| Phase | Duration (ex.) | REGISTRY_CONTRACT_ID env | Executor reads | Re-registration |
|------|---------------|---------------------------|------------------------|-------------|
| 1 | Day 0 | `C1` (old) | Only `C1` | Nobody |
| 2 | Deploy `C2` + grace period start (7 days) | `C1` (still) | Dual read `C1 || C2` in `is_executor_registered` | Executors re-register via API (marketplace UI button "Update registry for v2") → each calls `require_auth()` in `C2` |
| 3 | End of grace period (day 7) | `C2` (new) | Only `C2` | Closed. Executors who didn't migrate = implicitly removed from registry (can reactivate at any time by re-registering). |

The rollback of this migration is trivial: if `C2` shows unexpected behavior in phase 2, revert `REGISTRY_CONTRACT_ID` back to `C1` (time ~1 min) and turn off dual read. No on-chain transactions are reverted.

### Contractual obligations table with Escrow SaaS supplier (minimum checklist)

| Item | Required? | Why |
|------|--------------|---------|
| 2 independent external audits published for their escrow contract | ✅ Yes | Without this = P0 pubnet blocker. |
| 99.9% uptime SLA + 24/7 P0 channel for discovered on-chain vulnerabilities | ✅ Yes | Escrow bug = loss of executor funds. |
| Webhook verification public key (HMAC or Ed25519) to validate resolved dispute calls | ✅ Yes | Prevents spoofed "dispute won" webhook in favor of fraudulent executor. |
| 30-day deprecation notice + semantic changelog in API releases | ✅ Yes | Avoids silent integration regression. |
| Documentation of `pause/unpause` and its activation SLO in production | ✅ Yes | P0 incident plan depends on this. |
| Supplier publishes escrow contract address and its verified source code (Soroban verified WASM hash) | ✅ Yes | Transparency for us to independently audit if the `plugin-trustless-work` lib calls the expected address. |

### Supplier exit (Exit strategy) — "15 days without vendor" plan:

1. Develop `OurOwnEscrowContractClient implements IProviderEscrow` (~8 SP) with our contract (Soroban WASM) + deploy.
2. Active bids migration: executors re-create bids and collateral in the new contract. Tasks with accepted but not completed bid → off-chain `MIGRATE_ESCROW_TYPE` option per task.
3. Change env var `ESCROW_IMPLEMENTATION=ourown` in rolling deploy.

## Alternatives considered
- **Upgradeable Registry via admin key + `update_current_contract_wasm`**
  - Rejected: shorter patch time, but adds `admin` role = single point of failure. In Stellar Soroban, an "admin key" for a public registry contract is an obvious target; the security of the entire marketplace would depend on the custodian of that key (on-chain multisig or KMS). The blue-green approach via env var is less elegant, but more secure for MVP pubnet.
- **Implement our own Escrow (Soroban) contract instead of using Trustless Work SaaS**
  - Rejected: prohibitive cost in audit effort (escrow = Top 5 attackable in DeFi) + fiduciary responsibility. We use Trustless Work SaaS (which already has audit) for escrow, and keep the `IProviderEscrow` interface for exit strategy. MVP first, then consider own contract when volume justifies.
- **On-chain pause (Pauseable extension) in Registry itself**
  - Rejected: cost/complexity for low benefit. Pausing executor *registrations* does not respond to any real MVP incident; the attack vector is malicious executors, which we mitigate with off-chain allowlist/denylist and bid/task validation. Emergency pause at marketplace level is better handled via off-chain feature flag + 1 min redeployment.

---

## 7. Official SDF Testnet Deploy (08/06/2026)

| Field | Value |
|---|---|
| **Deploy Date** | 2026-08-06 |
| **Registry v2 Contract ID** | `CAC752B34ZYHHDTSHDVVHY3IX2R2UQHAN4AY5B57NZUY23XCYIEXSGPP` |
| **Escrow Option C Contract ID** | `CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH` |
| **Escrow WASM Hash (ADR0008 hotfix)** | `f89ae648…` (release build, 14 KB) |
| **Token SAC USDC Circle** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| **Admin / Marketplace Wallet** | `GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI` |
| **Stellar Expert Explorer Links** | [Registry](https://stellar.expert/explorer/testnet/contract/CAC752B34ZYHHDTSHDVVHY3IX2R2UQHAN4AY5B57NZUY23XCYIEXSGPP) · [Escrow](https://stellar.expert/explorer/testnet/contract/CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH) · [SAC USDC](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) · [Admin Wallet](https://stellar.expert/explorer/testnet/account/GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI) |
| **Status** | ✅ Deployed & Validated — `AlreadyInitialized #15` confirmed in both contracts (Instance storage written 100%). |
| **Related ADRs** | [ADR0007 Roles Separation](../0007-marketplace-role-dedicado-separado-releasesigner-p0-1-seguranca.md) · [ADR0008 token.require_auth hotfix](../0008-remocao-token-require-auth-initialize-p0-sac-usdc-testnet.md) |
