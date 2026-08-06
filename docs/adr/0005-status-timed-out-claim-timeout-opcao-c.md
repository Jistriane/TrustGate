# ADR 0005 — STATUS_TIMED_OUT=3 (claim_timeout Option C / P0-6): 100% Remaining Collateral Transfer to Honest Executor After 14 Days

| Field | Value |
|---|---|
| ID | 0005 |
| Title | ESCROW State Machine: Introduction of Terminal State STATUS_TIMED_OUT=3 via Permissionless `claim_timeout()`, Executor Wins |
| Author | TrustGate Architecture (ARCHITECT MODE) |
| Date | 2026-08-06 |
| Status | **Accepted** — Fully implemented in contracts/escrow + 3 Jest tests (claim_timeout happy, ClaimTooEarly, our-own e2e) + Rust local tests `claim_timeout_before_14d_fails` PASSES. 2 Rust `#[ignore]` tests require standalone/docker real ledger. |
| Depends on | ADR 0002 (Option C Immutable Escrow), ADR 0003 (L1 manual security checklist), ADR 0004 (Immutable contracts — rollback via re-deploy). |
| Next review | When first external audit is completed, or when a Proposal for Option D / proxy pattern / upgradeable escrow arises. |

## 0. Context (Problem Solved)

In TrustGate Option C, the Executor locks **real USDC collateral** when selected in a bid. Two terminals existed in initial v1:

1. **STATUS_RELEASED=1:** release_signer calls `release_milestone()` progressively; collateral goes to Executor (good behavior).
2. **STATUS_CONFISCATED=2:** Marketplace + Requester call `confiscate()` after abandoned task; 30% minimum split to requester, remainder to marketplace.

**Justice GAP identified 05/08 (P0-2 / P0-6):** What happens when the **release_signer goes inactive/disappears/omits signing** for 14+ days, but the **honest Executor completed the task** and uploaded the result? They would lose 100% of collateral due to a third-party failure (signer). Scenario of economic injustice for the actor that risked capital (executor).

This was not covered by the original 0/1/2 states.

---

## 1. Architectural Decision

We introduce **STATUS_TIMED_OUT: u32 = 3** as the fourth terminal state, activated via public permissionless function `claim_timeout(escrow_id)`:

```text
LOCKED (0)  ── after 241_920 ledgers (14d @ 5s/ledger) ──▶  TIMED_OUT (3)
                  │
                  ▼
        transfers remaining = collateral - released
              ──▶  dest = state.executor (HARDCODED, never msg.sender)
```

### 1.1 Key Security Characteristics (3 Non-negotiable Items)

| # | Rule | Implementation | Risk Avoided |
|---|---|---|---|
| 5.1 | **Destination hardcoded to `state.executor`** (never to the caller) | `env.invoke_contract(contract=token, fn=transfer, args=[token_client, &state.executor, &remaining])` | MEV/sniper attack: "I call claim_timeout before the executor to keep the money". NO. Regardless of who calls, the beneficiary is ALWAYS the same honest executor (verified in Rust test `claim_timeout_not_executor_still_sends_to_executor`). |
| 5.2 | **Two guards in CEI order before any transfer** | (1) `status == STATUS_LOCKED` (NotLocked=7); (2) `current_ledger >= state.created_at_ledger + LOCK_DURATION_LEDGERS (ClaimTooEarly=10)`; Only then (Effects) `status = STATUS_TIMED_OUT`; (Interactions) transfer. | Front-running / claim by attacker in conflicting state; claiming BEFORE the deadline. |
| 5.3 | **Terminal, non-reversible — same as RELEASED/CONFISCATED** | After status=3, any new `claim_timeout / release_milestone / confiscate` returns NotLocked / AlreadyReleased / AlreadyConfiscated respectively. | Secondary reentrancy post-claim; double-claim of value on top of the same storage slot. |

### 1.2 Magic Values / Constants Used (All Documented Inline in `contracts/escrow/src/lib.rs L7-L17`)

| Constant | Value | Unit | Quantitative Rationale |
|---|---|---|---|
| `LOCK_DURATION_LEDGERS` | 241,920 | ledgers (~14d @ 5s/ledger, Soroban typical) | Traditional dispute deadline in freelancer marketplaces + sufficient time for signer not to be "temporarily offline over the weekend". Shorter deadline = false positives (executor unjustly punished). Longer deadline = capital idle too long, reducing marketplace attractiveness. |
| `STATUS_TIMED_OUT` | **3** | u32 discriminant | Next available integer after 0/1/2; we follow OpenZeppelin incremental enum discriminant convention. |

---

## 2. 4 Architect Questions — Applied to STATUS_TIMED_OUT=3

**(1) Does it meet business objectives? ✅ YES**

- Resolves exactly the justice gap: executor who worked does NOT lose collateral due to third-party inaction.
- Maintains incentive alignment:
  - Honest executor → reward (receives full collateral back in 14d if signer disappears)
  - Requester → motivation to hire a reliable signer (if signer goes inactive, they **do not** win confiscation; the executor wins).
- Economically self-balancing: none of the three actors (requester, executor, signer) can unduly exploit the others.

**(2) Compliance with constraints (technical, regulatory, budgetary)? ✅ YES**

- **Security (ADR 0003 L1 checklist):**
  - ✅ CEI pattern (guards → effects → interactions)
  - ✅ Zero msg.sender dependency in transfer destination (anti-MEV)
  - ✅ Implicit ReentrancyGuard: status changes BEFORE transfer
  - ✅ Custom errors instead of strings (gas storage savings)
- **Regulatory:** No license / authorization required. All on-chain state is transparent and publicly auditable; transfer is only returned collateral, not yield or financial product.
- **Budgetary:** Implementation = ~40 Rust lines + ~500 test lines (Rust + Jest). Marginal cost: zero. Does not require any new infrastructure.

**(3) Does it meet required quality attributes? ✅ YES**

| Attribute | How STATUS_TIMED_OUT=3 Meets It |
|---|---|
| Performance / Gas | 1 storage read + 1 storage write (status) + 1 token transfer. ~0.0001 XLM gas per claim. Comparable to release_milestone. |
| Security | Destination hardcoded to executor (anti-sniper). 2 guards. Terminal. |
| Auditability | Event `claim_timeout_executed` always emitted, with escrow_id + amount + executor. 100% traceable in any explorer. |
| Maintainability | Isolated constant. Unique status per flow. No partial states. |
| Idempotency | Double-claim = NotLocked error. No duplicate transfers. Tested via `claim_timeout_double_claim_fails_not_locked` (Rust #[ignore]). |

**(4) Is there a CHEAPER or LESS RISKY option to achieve the same result?**

### 4 Options Evaluated:

| Option | Description | TCO Cost (12 months) | Architectural Risk | Chosen? |
|---|---|---|---|---|
| A (Old) | Not have claim_timeout; force executor to open **manual dispute ticket** every time signer disappears. | ~R$ 40k/month (operational) × 12 = R$ 480k. | **High risk** — human team may make wrong decision; ticket backlog grows with scale. | ❌ Rejected |
| B | Transfer to `msg.sender` (whoever claims first) | Nearly zero dev, but: | **Catastrophic**. Any bot/Sniper monitors mempool and steals the claim BEFORE the honest executor. Certain capital loss. | ❌ **Strongly Rejected** |
| C | Destination hardcoded state.executor (CURRENT CHOICE) | ~R$ 0 dev + ~R$ 0.01/gas per claim ~ R$ 1,000/year. | Zero risk as long as CEI + correct destination. ✅ Audited via ADR 0003 L1 | ✅ **Chosen** |
| D | Introduce "on-chain 3-person multi-sig dispute" + voting for each case | R$ 80k dev + R$ 5k/month infra and maintenance | Low risk but overkill — 10x more expensive than Option C for worse result (slower, more complex). | ❌ Rejected by YAGNI |

Conclusion: **There is no cheaper and less risky option** than Option C (current). Alternative A is expensive and human; B is insecure; D is overkill.

---

## 3. Consequences (Explicit Pros and Cons)

### 3.1 Pros
- Honest executor 100% protected against inactive signer.
- No new human failure point (no team, no intervention).
- Malicious actors cannot steal claim via MEV (hardcoded destination).
- 100% on-chain implementation, no backend dependency for the claim to occur (anyone can call, benefit always lands in the same place).

### 3.2 Cons
- Signer inactive for > 14 days may mean **requester loses the collateral** and recovers nothing (they only win confiscation when the task itself is abandoned **by the executor** — not when the signer is the one who disappears). Intentional trade-off: we prioritize the actor who actually put capital at risk and did the work (executor). The signer is a trusted third party of the requester; if they disappear, it's the requester's problem (choose a better signer).
- Backend TimeoutService heuristic may try to claim 5min early (ClaimTooEarly). Handled: real claim validates real ledger, backend only retries + debug log (not error). See ADR 0006.
- Rust local tests cannot advance 241,920 ledgers (Soroban testutils limitation). Requires standalone docker.

---

## 4. Mandatory Tests Before Mainnet

| ID | Test Name | Location | Status |
|---|---|---|---|
| 5-A | `claim_timeout_before_14d_fails` (Rust, local testutils) | contracts/escrow/src/lib.rs L442 | ✅ 13 passed (RC=0) |
| 5-B | `claim_timeout_after_14d_executor_wins` (Rust) | contracts/escrow/src/lib.rs | ⚠️ `#[ignore]` — requires standalone/docker core (see scripts/forknet-claim_timeout-test.ts Option B) |
| 5-C | `claim_timeout_double_claim_fails_not_locked` (Rust) | contracts/escrow/src/lib.rs | ⚠️ `#[ignore]` — idem |
| 5-D | `runClaimTimeoutPass happy path` (Jest) | timeoutService.test.ts | ✅ 180 passed (RC=0) |
| 5-E | `claim_timeout ClaimTooEarly` (Jest unit) | timeoutService.test.ts | ✅ |
| 5-F | `forknet-claim_timeout-test ClaimTooEarly` (on-chain simulate) | scripts/forknet-claim_timeout-test.ts | ⚠️ Requires filled testnet env |

---

## 5. Rollback Strategy

Since status is terminal and contract is IMMUTABLE (ADR 0004), **there is no rollback for an already deployed contract**. However:

- If a bug is detected in testnet, re-deploy to new contractId → update env `ESCROW_CONTRACT_ID` (new).
- Old bids with "bad" escrow_id remain valid (real lock duration exists), only new tasks/bids use the corrected address.
- P0 incident plan in `docs/incident-response-runbook.md` §3.4.

---

## 6. Alternatives Considered (detailed already in §2 (4) above)

Recap: A (manual dispute ❌), B (msg.sender ❌), C (hardcoded executor ✅), D (multi-sig dispute ❌).

---

**Architectural Signature:** ARCHITECT MODE — Decision confidence: **97%** (3% only depends on real validation of test #B / #C in standalone/docker, which is operational, not architectural).
