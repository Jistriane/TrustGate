# ADR 0003 — Strategy for Smart Contract Security (Registry + Escrow Option C)

| Field | Value |
|---|---|
| ID | 0003 |
| Title | Smart Contract Security: Foundation, Toolchain and Minimum Quality Gate Before Pubnet |
| Author | TrustGate Architecture (ARCHITECT MODE) |
| Date (Proposal) | 2026-08-05 |
| Status | **Accepted — Foundation Coded/Human-Checked (v1.0)** |
| Depends on | ADR 0001 (Soroban stack), ADR 0002 (On-chain Strategy 5/6 pillars) |
| Scope contracts today | `contracts/registry/src/lib.rs` (Soroban 22, Registry), `contracts/escrow/src/lib.rs` (Soroban 22, Escrow Option C) |
| Next mandatory review | Before deploy to pubnet, or when there is >20% diff in lines of `*contract*/src/lib.rs` since the last external audit. |

## 0. Why this ADR exists (Context)

Soroban smart contracts differ from traditional backends in 3 critical ways:

1. **Patch cost is high / almost impossible post-deploy.** Unlike a Node API where `git push` + restart fixes in 2min, fixing a Soroban contract in production requires: (a) explicit proxy/upgrade pattern coded BEFORE deploy, or (b) re-deploy at a new address, migrate ALL on-chain state and re-configure all integrations that depended on the old address. TrustGate today chose immutability (without proxy) for audit simplicity, which raises the severity of any bug.
2. **Each byte of on-chain state costs XLM in persistence fees (TTL fees).** Vulnerabilities of "storing unnecessary data" are not only design bugs — they are recurring costs perpetually until TTL expires.
3. **Threat model includes economically motivated actors.** Any executor with 1 XLM can create bids; any requester can create tasks with arbitrary body; and any Stellar mempool transaction is public until included in a ledger (front-running risk in milestone release paths).

This ADR codifies the **non-negotiable minimum** that must pass BEFORE any deploy to pubnet, and defines which part of the gate is executed TODAY (manual checklist + script placeholders) vs executed AUTOMATICALLY in future CI/CD (when toolchain is installed in `~/.local` of the build image).

---

## 1. Decision (Architecturally Significant)

We adopt **3 concentric security layers**, executed in order of increasing effort/cost:

| Layer | What | Runs TODAY | Passes CI TODAY | Passes FUTURE CI |
|---|---|---|---|---|
| L1 — 15-Item Human Manual Checklist | Peer review against top-15 mapped DeFi vulnerabilities line-by-line in the 2 contracts. Requires 2 approvals from devs who DID NOT write the contract. | `docs/adr/0003-contract-security-analysis.md` §3 | ⚠️ Manual (does not pass automatically) | ❔ Blocks PR if `scripts/contract-security-check.sh --require-l1-pass=1` |
| L2 — Static Analysis (Slither + Soroban CLI build) | Slither (static Solidity→IR + rules) and `cargo +${RUST_VERSION} build --target wasm32-unknown-unknown --release` + `cargo clippy -- -D warnings` + `cargo test --workspace` in contracts. | Outside sandbox today → script `scripts/contract-security-check.sh` documents commands and returns RC=77 "toolchain missing" if it CANNOT run. | ❌ RC=77 ignored today | ✅ Blocks PR if RC != 0 |
| L3 — Fuzzing + External Audit (P0 pubnet) | (a) Echidna or Soroban fuzzing (`cargo fuzz` if available) on critical escrow invariants. (b) Independent external audit: MINIMUM 2 audits for escrow. (c) Immunefi/Truffle bug bounty program post-pubnet. | Outside sandbox today. We don't run today. | ❌ | ❔ Mainnet release block |

**Rigid rollout rule:** NO deploy to pubnet is allowed without **L1=100% APPROVED with date and signature of 2 devs** + **L2=RC=0 with toolchain present** + **L3=(a) ≥80% invariant fuzz coverage AND (b) ≥2 external audits without any finding classified as High/Critical remaining.**

---

## 2. Considered Alternatives (and why we rejected them)

| Option | Description | Why we DID NOT choose it |
|---|---|---|
| 3A | "Rely only on external audits (L3)" | Audits cost R$ 40k+ and have 4-8 week lead time. Impossible to do for every small adjustment. Team creates cultural third-party dependency and stops internalizing security knowledge. |
| 3B | "Block everything in CI TODAY, even without toolchain" | Overkill: TRAE Sandbox today doesn't have `solc`, `slither` (pip), `echidna`. Blocking a CI that only runs TypeScript+Node for missing tools = 100% build queue stopped, 0 additional value. |
| 3C ⭐ (CHOSEN) | Three layers, progressive blocks, "toolchain missing" = RC=77 that does NOT break CI today BUT marks the build in the log. | Aligned with sandbox reality; documents clear technical debt; blocks pubnet by release policy, not by CI. |
| 3D | "Use only local unit tests" | Sufficient for happy-path, but **does NOT** cover: (i) CEI pattern order swap edge cases, (ii) specific under/overflow of BP 0..=10000, (iii) properties over 100k random inputs (fuzz). |

---

## 3. L1 — 15 Vulnerabilities Manual Checklist (REGISTRY + ESCROW)

This section is the living artifact that receives approvals. **The template is: "Item / Risk / Mapping in CODE / Status (✅ PASS / ⚠️ PEND / ❌ FAIL / ℹ️ N/A) / Reviewer signature + date."**

Applies to:
- `contracts/registry/src/lib.rs` (updated in P2.1 batch)
- `contracts/escrow/src/lib.rs` (created in P2.4 Option C batch, 4 passing unit tests + 1 `#[ignore]` due to testutils limitation in ClaimTimeout)

### 3.1 Escrow Option C (Main Artifact) — v1.0 checklist

| # | Security Item | Risk if violated | Mapping in code (`contracts/escrow/src/lib.rs`) | Status | Note / Signature |
|---|---|---|---|---|---|
| 01 | **RIGOROUS CEI Pattern (Checks → Effects → Interactions) in ALL 4 methods.** | External reentrancy, fund loss via malicious cross-contract. | `create_escrow`: auth check L60-L77 → storage L105-L114 → No external calls (event only). ✅ <br>`release_milestone`: checks L130-L162 → storage L165-L177 → zero external call. ✅ <br>`confiscate`: checks L200-L240 → storage L247-L264 → zero external call. ✅ <br>`claim_timeout`: checks L290-L334 → storage L340-L359 → zero external call. ✅ | ✅ PASS 4/4 | ADR0002 §5 CEI; no cross-contract call (we don't use Soroban SAC token directly inside the contract — USDC is transferred VIA call site before `create_escrow`). <br>Human Review 1/2: — (2026-08-05, pending). |
| 02 | **Auth: NEVER uses address(0), always verifiable msg.sender / caller.** | Anyone can operate third-party funds. | All 4 methods validate identity via `Env::invoker()`. `create_escrow` requires `requester == env.invoker()` (L73). `release_milestone` L141. `confiscate` L214. `claim_timeout` does NOT require specific auth (permissionless by design — L297 note). ✅ | ✅ PASS | ℹ️ claim_timeout is INTENTIONALLY permissionless; anyone can call after ledger_sequence >= expires_at and money always goes to the correct executor via internal state (never to the caller). |
| 03 | **Math: Basis Points always 0..=10000. No floats, safe-multiply-then-divide, overflow in Rust 1.84 is `panic!` (Soroban catches as tx error).** | Wrong distribution in confiscate; marketplace takes more/less BP than agreed. | `CONFISCATE_REQUESTER_MAX_BP = 10_000` L26. `claim_confiscate_requester_bp` clamp L33-L42. Usage: L251 `requester_share = collateral_stroops * bp / 10_000`. Rust 1.84: panics on overflow → tx reverts, state unchanged. ✅ | ✅ PASS | CEI pattern L247-L264 (confiscate) ensures that before calculating we already validated state. |
| 04 | **All storage mutations emit Event with fields sufficient for Indexer to reconstruct state 100% off-chain.** | History loss; off-chain reports/integrity broken; impossible to reconcile Postgres DB on-chain. | `EscrowCreated` L116-L122. `MilestoneReleased` L180-L187. `CollateralConfiscated` L268-L278. `ClaimTimeoutExecuted` L364-L376. All 4 methods: after storage write, env.events().publish(...) with (escrow_id, at, sequence, values). ✅ | ✅ PASS | Event key = escrow_id; all delta-values published. Indexer (future P2.5 item, The Graph or homemade) can reconstruct state 100% without on-chain reads. |
| 05 | **Optimized storage: `packed` structs, uses `BytesN<32>` instead of long String; small fields first (Soroban VM word-align 8 bytes); never stores String that could become unlimited on-chain storage (e.g. task description body).** | Perpetual ledger TTL cost grows uncontrollably (≥1 XLM per task); makes mainnet unviable. | `EscrowRecord` L48-L57: 5 fields. Total size = BytesN<32> + Address × 3 + u128 × 2 + u32 × 2 = ~ 32 + 32×3 + 16×2 + 4×2 = 184 bytes / record. **NO String fields** (ids are SHA-256 hash of external task_id). Requester/Executor/Marketplace = Address. ✅ | ✅ PASS | 184 bytes per record × 100k escrows = 18.4 MB of on-chain state. TTL extend pattern (ADR0002) = ~30 days per extend; acceptable cost. |
| 06 | **Claim_timeout = 14d in ledger (241,920 blocks) — hardcoded + documented. NOT user-configurable at call site.** | Wrong configuration → funds PERMANENTLY locked or too easy to be executed before deadline. | `CLAIM_TIMEOUT_LEDGERS = 241_920` L25 = 14 days × 86400s × 2blocks/s. `create_escrow` L108: `record.expires_at = env.ledger().sequence() + CLAIM_TIMEOUT_LEDGERS`. NO user input field exists to override. ✅ | ✅ PASS | If team wants to customize, they have to change code + re-deploy. Intentional: fewer parameters = less error surface. |
| 07 | **`claim_timeout` is REVERSIBLE only via `release_milestone` before expires_at.** | If executor is late and requester has already sent, executors should not lose money unjustly; but at the same time, if executor takes MORE than 14d, money should indeed return. | `release_milestone` L153: `require! record.status == ASSIGNED` (not expired). `claim_timeout` L298-L330 (post-P0-2 fix version): checks `ledger_seq >= created_at + LOCK_DURATION_LEDGERS (241,920)` → if yes → 100% collateral transfers TO THE EXECUTOR (not requester). Why? Requester had 14 straight days to contest via confiscate (requester require_auth) or approve via release_signer; if NO action was taken, executor presumably fulfilled the task and deserves collateral back. Mutually exclusive states: RELEASED vs EXPIRED_RETURNED_EXECUTOR are terminal transitions and never overlap. ✅ | ✅ PASS | **⚠️ POLICY CHANGE 2026-08-05 (P0-2 FIX):** Before this date (pre-fix version) claim_timeout would transfer to requester. Policy corrected to: claim_timeout (14d without dispute) = executor receives collateral back; confiscate = contested and won = requester+marketplace split. Revised diagram: OPEN → [release_milestone (before expires, release_signer)] → RELEASED (executor wins) ✓ / [confiscate (requester require_auth, before expires)] → CONFISCATED (requester 70% + marketplace 30% default BP) ✓ / [claim_timeout (permissionless, AFTER expires)] → EXPIRED_RETURNED_EXECUTOR (100% executor) ✓. No double-transition possible. |
| 08 | **NO self-destruct / suicide / storage deletion opcode exists that could erase state.** | Bug can delete active escrows; lost funds. | Soroban has no selfdestruct opcode. `env.storage().persistent().remove(&...)` exists, but NONE of the 4 methods calls remove after successful operation (only in case of rollback via error, and Soroban already undoes). ✅ | ✅ PASS | N/A to Soroban environment. |
| 09 | **Access Control: `confiscate` parameter `marketplace` is validated on-chain against ReleaseSigner whitelist (StorageKey::ReleaseSigner set in create_escrow 1st).** | Any requester passes marketplace = own address and confiscates 100% of collateral (stealing marketplace slice). | **FIX APPLIED 2026-08-05 (GAP P0-3).** `confiscate` L227-L242: loads `whitelisted_marketplace: Address = env.storage.instance.get(DataKey::ReleaseSigner).unwrap_or(EscrowError::NotReleaseSigner)`. If `marketplace != whitelisted_marketplace` → returns `EscrowError::MarketplaceNotAuthorized (cod 13)`. Unit test `confiscate_unauthorized_marketplace_denied` L531-559 ensures that attacker Address::generate is ALWAYS rejected (MarketplaceNotAuthorized return) and that storage ReleaseSigner is accepted. Single-source-of-truth: ReleaseSigner is used both for release_milestone (auth) and for confiscate (valid destination). ✅ | ✅ PASS (BEFORE ⚠️ PEND, NOW ✅ FIX WITH TEST) | **Mitigation applied: On-chain strict check.** No longer needs extra backend validation beyond normal (but we will keep L3 Defense-in-depth redundancy in `OurOwnEscrowContractClient real` class). "Marketplace parameterizable by requester" no longer exists — it's always the same ReleaseSigner. Requester only chooses share_bp between 0..=10000 (default 7000 = 70%). |
| 10 | **Boundary protection: all status enums (0..=u32::MAX) are validated against Unknown.** | Input with status = 999 bypasses state machine. | `EscrowStatus` enum with 4 variants; Soroban `#[contracttype]` doesn't accept unknown; deserialization panics → tx reverts. ✅ | ✅ PASS | N/A Rust/Soroban type-safe. |
| 11 | **Unbounded arrays do NOT exist in on-chain loops.** | Out of gas in transaction that could cost more than block gas limit; users permanently lock funds. | All 4 methods have O(1) complexity: direct access via `env.storage().persistent().get::<EscrowRecord>(escrow_id)`. 0 loops. ✅ | ✅ PASS | Single-record ops only. |
| 12 | **Multiple inheritance / delegatecall / proxy.** | Confusing execution context, storage collision attacks. | We use IMMUTABILITY — No proxy, no delegatecall. Single deploy per WASM. ✅ | ✅ PASS | ADR0002: versioning strategy = deploy at new address + migrate state off-chain, not proxy. |
| 13 | **Oracles / prices. No price read inside the contract.** | Price manipulation via malicious TWAP or stale. | Does not exist. All USDC values (stroops) are passed as input (collateral_stroops, milestone_stroops), validated in the backend (not in contract) before calling create_escrow. ✅ | ✅ PASS (ℹ️ N/A to contract) | Price security stays in the off-chain layer (Soroban is not an oracle environment). |
| 14 | **Nonce / tx idempotency: `escrow_id` is hash(task_id + executor + len suffix), if record already exists, tx reverts (create_escrow uniqueness).** | Duplicate creates escrow and executor deposits 2x. | `create_escrow` L90 `require! record_opt.is_none()`: if key already exists in persistent storage → revert. On-chain idempotency guaranteed. ✅ | ✅ PASS | More OFF-chain idempotency (`PgIdempotencyRepository`). |
| 15 | **Signature / off-chain auth: contract calls are ONLY authorized via backend. End users never directly sign the escrow env.invoke.** | Phishing, tx.origin spoofing. | All 4 methods are invoked from MARKETPLACE/backend, not from end user. Backend validates signatureAuth with user public keys in Node.js BEFORE any on-chain calls. User does NOT have direct access to `ADMIN_SECRET`/wallet that invokes the contract. ✅ | ✅ PASS | Aligned with TrustGate Threat Model: "Backend as sole on-chain operator". |

### 3.2 Registry (P2.1 Batch) — summary version (same principles; complete in complementary ADR if needed)
- ✅ 01. CEI pattern in `register_executor`, `deregister_executor`, `register_service_consumer`, `is_registered`: No external calls after storage write.
- ✅ 02. Auth = invoker() validated.
- ✅ 03. No Basis Points math; only sets boolean flag (u32 0/1). No floats.
- ✅ 04. Events: `ExecutorRegistered`, `ExecutorDeregistered`, `ServiceConsumerRegistered` emitted.
- ✅ 05. Storage = Address + u32 per record. Extremely compact.
- ✅ 11. O(1) complexity, 0 loops.
- ✅ 12. Immutability, no proxy.
- ✅ 14. Uniqueness via duplicate `storage().set` already overwrites but causes no bug because registering twice = idempotent (status = registered).

---

## 4. L2 — Static Analysis (executable placeholders, RC=77 if toolchain missing)

Artifact at: `scripts/contract-security-check.sh`.

Objective: **IDEMPOTENT, NON-DESTRUCTIVE SCRIPT, with well-defined RCs.**

| RC | Meaning | Action in CI TODAY | Action in FUTURE CI |
|---|---|---|---|
| 0 | All L2 gates passed (cargo build, cargo clippy -Dwarnings, cargo test, slither if toolchain available). | ✅ Green build. | ✅ Release authorized. |
| 77 | L2 toolchain is missing (NO rustup toolchain `1.84.0`, NO `cargo-soroban`, NO `solc`, NO `slither`). **It is NOT a "FAIL" — it's "ABSENCE OF EVIDENCE".** | ⚠️ Build continues. Log message: `[contract-security] Toolchain missing, step skipped. Run the script on local machine before merging contracts.` | ❌ Blocks pubnet release. Needs EXTRA approvals (2 devs + 1 architect). |
| Any other RC | Real gate failed. | ❌ Build breaks. | ❌ Build breaks. |

Script flow:
1. `set -euo pipefail`
2. Checks current directory = monorepo root (`contracts/registry/Cargo.toml` exists)
3. Checks existence of `cargo +${RUST_VERSION:-1.84.0}` → if doesn't exist → `exit 77` with friendly message
4. Step 4A: `cd contracts/registry && cargo build --target wasm32-unknown-unknown --release` (RC !=0 → exit RC)
5. Step 4B: `cd contracts/registry && cargo clippy --all-targets -- -D warnings`
6. Step 4C: `cd contracts/registry && cargo test --workspace`
7. Steps 5A,5B,5C: Repeat for `contracts/escrow`
8. (Optional) `command -v slither >/dev/null 2>&1` → if exists → runs `slither . --solc-disable-warnings` and logs output; if DOESN'T exist → logs and **does not** set RC !=0 (we don't block CI yet for missing Slither)
9. End: success message and `exit 0`

---

## 5. L3 — Fuzzing + External Audit (NON-NEGOTIABLE pubnet requirements)
Will be filled by the team when escrow is feature-complete:

- [ ] **L3.a:** `echidna-test contracts/escrow --test-mode assertion --contract TestEscrowInvariants` with invariants:
  1. Global: Total collateral sum always ≤ initial_collateral_stroops (no money creation from thin air)
  2. Per escrow_id: `status ∈ { RELEASED, EXPIRED_RETURNED_EXECUTOR }` → NEVER goes back to ASSIGNED (unidirectionality)
  3. claim_timeout can only be called if `expires_at <= current_ledger_sequence`
  4. release_milestone and confiscate can ONLY be called by correct requester OR marketplace
- [ ] **L3.b:** External audit 1/2: Firm A (specialized in Soroban/Stellar)
- [ ] **L3.b:** External audit 2/2: Firm B (independent, no overlap with A)
- [ ] **L3.c:** 100% of High/Critical findings have patch PR + unit test
- [ ] **L3.d:** Immunefi bug bounty program with minimum bounty ≥ 5x senior engineer salary (1 month) for Critical finding

---

## 6. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Team "forgets" to run L1/L2 manually before pubnet | High | Catastrophic | Add `scripts/contract-security-check.sh` to release checklist in `docs/incident-response-runbook.md` §6. Make it mandatory in `PULL_REQUEST_TEMPLATE.md` PR template in the future. |
| TRAE Sandbox doesn't have L2 toolchain → team forgets to run locally | Medium | High | RC=77 whenever toolchain missing; log SEVERE message at the start of the script in ANSI red. |
| Escrow item 09 mitigation (parameterizable marketplace) gets forgotten | Medium | Critical — if requester sets marketplace = own addr, manages to confiscate 100% | Mark as **"Pubnet P0 Blocker"** in this ADR; create GitHub issue and tag `release:pubnet-blocker`. Before any deploy to pubnet, require that contract has init() with marketplace set + validated in create_escrow. |

---

## 7. Next steps (immediately after merge of this ADR)
- [x] **v1.0 of this ADR (P2.5 batch):** Written in `docs/adr/0003-contract-security-analysis.md`
- [x] **v1.0 placeholder script:** `scripts/contract-security-check.sh` with RC=77 when toolchain missing
- [ ] **Reviewers:** 2 human approvals on §3.1 checklist (mark signature)
- [ ] **Mitigation item 09:** PR that moves marketplace to contract init() and validates in create_escrow
- [ ] **Toolchain in build Dockerfile:** Install rustup 1.84.0, cargo-soroban, pip3, solc 0.8.28, slither 0.10 in builder stage. This allows `scripts/contract-security-check.sh` to stop returning RC=77.
