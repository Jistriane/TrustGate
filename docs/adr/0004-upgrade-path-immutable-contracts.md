# ADR 0004 — Upgrade Path for Immutable Contracts (Registry + Escrow Option C)

| Field | Value |
|---|---|
| ID | 0004 |
| Title | Upgrade / Migration Strategy for Immutable Soroban Contracts — 7-Day Grace Period, Dual-Read, Manual Rollback |
| Author | TrustGate Architecture (ARCHITECT MODE) |
| Date (Proposal) | 2026-08-06 |
| Status | **Accepted — Conservative Default (v1.0)** |
| Depends on | ADR 0002 (On-chain Strategy: Immutable Registry/Escrow), ADR 0003 (Contract security / 2 pubnet audits) |
| Scope | `contracts/registry/src/lib.rs`, `contracts/escrow/src/lib.rs`, deployments `scripts/deploy-*.ts`, TS backend `src/services/*`, indexer / analytics DB |
| Next mandatory review | Before 1st deploy to pubnet, or when any public endpoint (backend) changes contract ID without dual-read flag. |

## 0. Why this ADR exists (Context)

TrustGate chose **immutability without Proxy pattern** (ADR 0002) for Registry and Escrow Option C. Accepted trade-off:

- ➕ Simpler auditability: a single WASM hash per contract, no indirect `delegatecall`, no proxy storage slot collision.
- ➕ Smaller attack surface: no on-chain `upgrade(address newImpl)` that an attacker could exploit (however small the chance).
- ➖ **MUCH higher upgrade cost**: any new bug / new feature = **new contract address** + **migrated state (if applicable)** + **all integrations re-configured**.

This ADR solves the "minus" above: it defines the **MANDATORY MINIMUM upgrade protocol** that must be followed **whenever any immutable contract is replaced**, even on testnet. The goal is:

> *"Make immutable contract upgrade as safe and auditable as a proxy pattern — without the risks of the proxy pattern."*

---

## 1. Decision (Architecturally Significant)

We adopt **4 sequential, NON-SKIPPABLE stages** for any Registry or Escrow contract upgrade. No new contract deploy can be marked "active" in the backend without completing all 4 stages in order:

### Stage 0 — "Conception and Build" (T-21 days minimum)
- [ ] `cargo build --target wasm32-unknown-unknown --release` + `cargo test` **both** RC=0 on the new WASM.
- [ ] `cargo clippy -- -D warnings` RC=0.
- [ ] **Rust lines diff vs previous contract:** if >20% of lines changed → EXTRA audit trigger (ADR 0003 L1 checklist **re-run** even if contract was audited).
- [ ] Static L2 application (Slither / Soroban-CLI) if toolchain present; if missing → artifact `reports/l2-<contract>-<date>.md` with justification and exact command.

### Stage 1 — "Silent Dual-Read" (T to T+7 days, MINIMUM 7 DAYS)
The NEW contract (address N) is deployed but **no mutation is written to it yet**. Backend alternates **only reads** (view methods `is_registered`, `get_executor`, `is_paused`, `get_escrow`) between PREVIOUS_CONTRACT (A) and NEW_CONTRACT (N) at a **1% traffic-shadow** rate, then 10%, then 100%.

Hard dual-read rule:
```ts
// Single source of truth at runtime:
// src/config/stellar.ts (or .env)
export const REGISTRY_CONTRACT_ID_PRIMARY = "<A>";    // where writes happen (still)
export const REGISTRY_CONTRACT_ID_SECONDARY = "<N>";  // only shadow reads
export const REGISTRY_DUAL_READ_PCT = 10;             // 0 to 100, controlled by feature flag
```

If `REGISTRY_DUAL_READ_PCT < 100` OR `REGISTRY_CONTRACT_ID_SECONDARY === ""` → **WE CANNOT JUMP TO STAGE 2**.

This stage detects: type serialization bugs (new EscrowState `released: i128` vs old TS bindings), gas differences in views, RPC nodes that fail on the new address due to cold TTL.

### Stage 2 — "Gradual Writes + Automatic Rollback" (T+7 to T+14 days)
When dual-read is 100% for at least 7 consecutive days WITHOUT ALERTS:

```ts
export const REGISTRY_WRITE_PCT = 5;  // starts with 5% of mutations going to NEW contract
```

**Any write error in NEW contract (any RC != 0 or ContractResult isErr) in ≥2 consecutive requests → write PCT drops back to 0 automatically (circuit breaker).** The failed operation is retried on contract A (old) transparently to the user (fallback).

For Registry: every `registerExecutor` on contract N must also trigger an asynchronous "backfill" (Outbox pattern) to populate old contract A with the same entry — for up to 30 days after stage 2. This ensures rollback (Stage 3b) never has missing data.

For Escrow: new `createEscrow` can only start being written to N **AFTER ALL escrows in A are terminal (STATUS_RELEASED / STATUS_CONFISCATED / STATUS_TIMED_OUT)**. LOCKED escrows in A are NEVER migrated on-chain — they remain resolved in contract A (it is acceptable to have 2 active escrow addresses, the backend only needs `escrowContractId` saved in `BidRepository.escrow_id` to know which contract to call).

### Stage 3a — "Total Cutover" (T+14+)
```ts
export const REGISTRY_CONTRACT_ID_PRIMARY = "<N>";    // N is primary
export const REGISTRY_CONTRACT_ID_SECONDARY = "<A>";  // A becomes read-only fallback
export const REGISTRY_DUAL_READ_PCT = 100;
export const REGISTRY_WRITE_PCT = 100;
```

**Mandatory manual operation:** 2 different engineers must sign (in GitHub PR or in file `docs/adr/approvals/0004-<contract>-<date>.sig.md`) that:
- Stage 1 ran ≥ 7 days with 0 read diff alerts.
- Stage 2 ran ≥ 7 days with 0 circuit breaker triggers.
- Previous contract A has instance TTL extended to ≥ 180 days (`INSTANCE_TTL_EXTEND_TO >= 3_110_400` = ~6 months) **BEFORE** ceasing to be primary. This prevents "historical state loss" from expired TTL in abandoned old contract.

### Stage 3b — "Rollback (P0 emergency exit)"
**If something goes wrong in Stage 2 or 3a**, any on-call team member can, WITHOUT NEED FOR APPROVAL:
```bash
# Edit .env (or AWS Parameter Store / HashiCorp Vault)
REGISTRY_CONTRACT_ID_PRIMARY="<A>"
REGISTRY_CONTRACT_ID_SECONDARY=""
REGISTRY_DUAL_READ_PCT=100
REGISTRY_WRITE_PCT=0
# Redeploy backend.
```

Registry backfill (if there's data only in N that needs to go back to A): idempotent script `scripts/oneoff/backfill-registry-a-from-n.ts`, already versioned in the repo BEFORE stage 2.

---

## 2. Considered Alternatives (Trade-offs)

| Option | Description | Why we DID NOT choose TODAY |
|---|---|---|
| 4A — Proxy Pattern (Upgradeable by Owner) | Transparent to client: address never changes. | Risk: on-chain `upgradeTo(address)` = 1 function that, if exploited, breaks the ENTIRE contract. Implies strict storage layout locks. More expensive audit. **Re-evaluate in v2 if upgrades become frequent (> 4/year).** |
| 4B — "Big Bang Cutover" (skip stages 1 and 2) | Deploy N → change environment variable → done. | P0 risk: if contract N has serialization bug or unstable RPC, the ENTIRE marketplace goes down. In DeFi, this pattern causes fund losses when it involves escrow. |
| 4C ⭐ (CHOSEN) — 4 Stages + 7+7 days grace + one-env-var rollback | Trade-off: minimum 14 days per upgrade → a bit slower → but zero downtime risk for end user and complete audit trail per contract. | **Conservative default.** Re-evaluate if there's business pressure for more frequent upgrades (then migrate to 4A with EXTRA audits). |
| 4D — "Deploy N and let A die (no TTL extend)" | Economical in XLM persistence. | NO: executor registration history (registered_at_ledger) is audit / AML / executor reputation score data. Losing them = breaking SLA with integrators and off-chain analytics. |

---

## 3. Per-Contract Deploy Checklist (copy/paste into upgrade PR)

### 3.1 Registry — Upgrade Checklist

- [ ] Stage 0: Rust build/test/clippy RC=0. ADR 0003 L1 re-approved by 2 devs.
- [ ] Stage 1 (≥ 7d): `REGISTRY_DUAL_READ_PCT` climbed 1% → 10% → 100%. Grafana (or Pino logs) confirms 0 diffs between A and N in `isRegistered`/`getExecutor` responses.
- [ ] Stage 2 (≥ 7d): `REGISTRY_WRITE_PCT` climbed 5% → 25% → 100%. 0 circuit breaker. Backfill A ↔ N is running in the Worker.
- [ ] Stage 3a: Cutover. 2 human signatures. Old contract instance TTL extended ≥ 6 months on-chain via `extend_ttl(100, 3110400)`.
- [ ] Script `backfill-registry-a-from-n.ts` committed and ready (even if never used).

### 3.2 Escrow Option C — Upgrade Checklist

- [ ] Stage 0: same as Registry. **Additional:** CEI pattern validated L1 ADR 0003 again. Reentrancy / pauser / transfer_pauser tested.
- [ ] Stage 1 (≥ 7d): dual-read `get_escrow` / `is_paused` 100%.
- [ ] Pre-Stage 2 (mandatory): metric `count_escrow_locked_in_A = 0` confirmed via indexer or batch script. **We do NOT accept migrating LOCKED on-chain escrows between addresses — too much race condition risk.**
- [ ] Stage 2 (≥ 7d): gradual `ESCROW_WRITE_PCT`. New `createEscrow` only in N.
- [ ] Stage 3a: Cutover. Contract A TTL extended ≥ 12 months (since escrow can take 14d + dispute = months to resolve, and address must remain callable).
- [ ] 2 external audits (ADR 0003) with High/Critical findings = 0.

---

## 4. Mandatory Observability and Alerts

This entire upgrade strategy is useless if no one is alerted when something fails. Non-negotiable minimum in Prometheus/Grafana (Loki Pino logs):

| Alert | Condition | Severity | Channel |
|---|---|---|---|
| `registry_dual_read_diff_total > 0` | Read in A != read in N (JSON deep-equal) | P1 | Slack #oncall + dev lead email |
| `registry_write_circuit_breaker_total > 0` | Writing to N failed ≥ 2x consecutively → PCT dropped back to 0 | P1 | Slack #oncall + page |
| `escrow_locked_remaining_A > 0 and escrow_write_pct_N > 0` | We tried Escrow Stage 2 without zeroing LOCKED in A | P0 | Page + automatic block (doesn't let PCT rise) |
| `contract_instance_ttl_days < 45` | Any contract (A or N) with less than 45 days of remaining TTL | P1 | Slack #ops-attention |

---

## 5. Justification for Conservative Default

The architect's 4 questions:

1. **Meets business objectives?** ✅ Yes. Safe upgrades = confidence from executors/requesters that escrow funds won't disappear due to upgrade bug.
2. **Complies with constraints?** ✅ Yes. ADR 0002 chose immutability; this ADR respects the decision and only adds process.
3. **Quality attributes?** ✅ Availability (dual-read + gradual write = 0 expected downtime). Security (7d+7d grace captures edge cases). Maintainability (copyable checklist, one-env-var rollback).
4. **Is there a cheaper / less risky option?** ⚠️ Yes — Option 4A (Proxy) is cheaper in upgrade time, but **riskier in attack surface**. Given TrustGate handles USDC collateral on-chain, security > speed. Option 4C is the "least risky one that actually works".

---

## 6. Approvals (Pre-Stage 2)

| Person / Role | Signature | Date | Minimum Approved Stage |
|---|---|---|---|
| _Dev lead / Tech Writer_ | __________________ | ________ | Pre-Stage 0 (this ADR accepted) |
| _Security Reviewer 1_ | __________________ | ________ | Pre-Stage 2 (writes can start) |
| _Security Reviewer 2_ | __________________ | ________ | Pre-Stage 2 (idem) |
| _On-call SRE / Ops_ | __________________ | ________ | Pre-Stage 3a (cutover ok) |
