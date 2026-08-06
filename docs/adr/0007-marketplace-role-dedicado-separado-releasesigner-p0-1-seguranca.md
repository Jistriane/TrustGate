# ADR 0007 — Roles Separation in initialize: Dedicated Marketplace Separate from ReleaseSigner (P0-1 Pubnet Level Security)

| Field | Value |
|---|---|
| ID | 0007 |
| Title | Separation of Roles `ReleaseSigner` ↔ `Marketplace` in `DataKey` and `initialize(3 args)`. Protection against GAP P0-1 spoof requester create_escrow + centralized confiscation authority. |
| Author | TrustGate Architecture (ARCHITECT MODE) |
| Date | 2026-08-06 |
| Status | **Accepted** — 100% Implemented in contracts/escrow + TS bindings + deploy script initialize 3 args + Jest 2 ISO binding initialize tests + Rust 13/13P workspace. |
| Depends on | ADR 0002 (Option C Immutable Escrow), ADR 0003 (L1 security 2 devs), ADR 0004 (immutable: rollback via re-deploy). |
| Next review | If a proposal for distributed confiscation authority arises (2/3 multisig Marketplace) or if `confiscate` needs to become permissionless with economic threshold (e.g.: 51% token stake). |

---

## 0. Context (Problems Solved)

Before this decision, the `Escrow Option C` contract used **a single Storage variant for TWO distinct authority roles**:

```rust
// PRE-ADR 0007 (Initial V1, GAP P0-1 identified 06/08):
enum DataKey {
    Escrow, Nonce, Token, ReleaseSigner, Pauser, IsPaused
    //   ^^^^^ ReleaseSigner = was ALSO used as "authorized Marketplace" in confiscate.
}
fn initialize(token, release_signer) { /* 2 args, saved DataKey::ReleaseSigner. */ }
fn confiscate(marketplace, ...) {
    let whitelist = DataKey::ReleaseSigner;  // ← BUG: same role for 2 purposes.
    if marketplace != whitelist { return NotReleaseSigner; }
}
```

This created **TWO independent Security GAPs**:

### 0.1 GAP P0-1a: `requester` spoof in create_escrow → 30% confiscation share theft

The old `create_escrow()` **only required `executor.require_auth()`**. Nothing validated that `requester` owned their private key.

**Attack vector:**
1. Attacker calls `create_escrow(executor=friend, requester=attacker, collateral_amount=1000 USDC)` — **without needing the attacker's key**.
2. Attacker abandons task → ASSIGNED/LOCKED status.
3. Attacker calls `confiscate()` using state.requester = attacker key.
4. Before the 30% min requester_bp rule: attacker steals **300 USDC (30%)** per mass exploitable task.

**Risk level:** P0 PUBNET LEVEL — exploitation cost 1 create_escrow transaction (~0.01 XLM), potential return 30% of all collateral already locked in any available task.

### 0.2 GAP P0-1b: Collapse of 2 roles into 1 address

If ReleaseSigner and Marketplace were the same wallet for "convenience":

- ReleaseSigner = **cold/offline** wallet (should sign milestones 1x/day, rare operation).
- Marketplace = **hot/online** wallet (needs to call `confiscate()` in automated backend workflow, 24/7).

**Result:** We would have to keep release_signer online (breaks SOP) OR delay confiscation for hours until offline operator is released (bad SLA). "Same address" architecture = **lower security AND lower availability**, simultaneously.

---

## 1. Architectural Decision

**Two complementary changes + 1 security assertion:**

### 1.1 `DataKey::Marketplace` — NEW dedicated role

```rust
// POST-ADR 0007:
enum DataKey {
    Escrow, Nonce, Token,
    ReleaseSigner,  // 1 role: sign release_milestone (cold wallet ideal)
    Marketplace,    // 2 NEW role: confiscation authority (backend SRE hot wallet)
    Pauser, IsPaused,
}
```

### 1.2 `initialize(token, release_signer, marketplace)` — NOW 3 mandatory args

```rust
pub fn initialize(env: Env, token: Address, release_signer: Address, marketplace: Address) -> Result<()> {
    // Checks first (CEI):
    if env.storage().instance().has(&DataKey::Token) { return Err(AlreadyInitialized); }
    token.require_auth();
    release_signer.require_auth();
    if marketplace != release_signer {   // hotfix V14 (same address → no need 2x require_auth same signer)
        marketplace.require_auth();       // NEW! Marketplace address CONSENTS to being authority.
    }
    // Effects (all storage):
    env.storage().instance().set(&DataKey::Token, &token);
    env.storage().instance().set(&DataKey::ReleaseSigner, &release_signer);
    env.storage().instance().set(&DataKey::Marketplace, &marketplace);  // saved separately
    env.storage().instance().set(&DataKey::Pauser, &release_signer);    // keeps release_signer as default pauser
    env.storage().instance().set(&DataKey::IsPaused, &0u32);
    Ok(())
}
```

### 1.3 create_escrow now requires **2 require_auth** (definitive P0-1a fix)

```rust
pub fn create_escrow(..., executor: Address, requester: Address, ...) -> Result<EscrowId> {
    executor.require_auth();
    requester.require_auth();  // === LINE 314, CLOSES GAP P0-1a ===
    if collateral_amount <= 0 { return Err(ZeroCollateral); }
    ...
}
```

### 1.4 `confiscate` now compares against DataKey::Marketplace (not ReleaseSigner)

```rust
fn confiscate(marketplace: Address, escrow_id: EscrowId, ...) -> Result<()> {
    // ... CEI checks ...
    let whitelist: Address = env.storage().instance()
        .get(&DataKey::Marketplace)               // NO LONGER DataKey::ReleaseSigner
        .ok_or(EscrowError::NotInitialized)?;
    if marketplace != whitelist {
        return Err(EscrowError::MarketplaceNotAuthorized);
    }
    ...
}
```

---

## 2. Architectural Options Considered (3 candidates)

| ID | Candidate Architecture | Complexity (dev) | Security Risk | Impl Type |
|----|------------------------|--------------------|-----------------|---------------|
| **A. (Before, REJECTED)** | Collapsed roles ReleaseSigner = Marketplace + 2 args initialize + WITHOUT requester.require_auth | **Low, 2 lines** | **High P0 — mass 30% confiscation share theft attack vector** | ❌ Rejected |
| **B. (Chosen ✅)** | Separate Marketplace role dedicated DataKey + initialize 3 args + requester.require_auth create_escrow | **Medium, ~80 Rust lines + TS bindings + 3 args deploy script** | **Minimum** — roles have least privilege; each require_auth guarantees ownership | ✅ Accepted |
| **C. (Overkill, REJECTED for Option C)** | Permissionless threshold confiscation based on token stake or 2/3 on-chain multisig (Squads) | **High, 400+ lines, new multisig contract** | Medium (reduces surface but brings governance vectors) | ❌ Rejected by YAGNI. Option C is IMMUTABLE; adding complex governance now reduces test surface in v1. Revisit in v2 if task volume > 10k/month. |

### Accepted trade-off for Option B:
- **Cons:** initialize now has 3 args (1 extra) → all Rust unit tests updated from `client.initialize(a, b)` to `client.initialize(a, b, c)`. Cost ~2h tests + bindings update.
- **Pros:** Pure least privilege. ReleaseSigner stays secure OFFLINE; Marketplace ONLINE in backend running automatic confiscation. GAP P0-1 CLOSED.

---

## 3. Identified Risks + Mitigations

| Risk | Probability | Impact | Mitigation |
|-------|---------------|---------|-----------|
| Someone regenerating automatic Soroban bindings and reverting `pauser` field (which would revert initialize args back to 2 args or wrong name) | Medium | Medium (staging deploy initialize would break without obvious explanation) | **ISO Test P2-7** in `src/contracts/bindings/escrow/initialize-binding.test.ts` with 2 tests: reflects 3 correct names, does NOT contain `pauser` key. Jest build breaks if regression. |
| Same address marketplace == release_signer (initial staging deploy for simplicity) → duplicate `marketplace.require_auth()` in same Soroban Auth frame = `Existing auth entry` error | High | Low (costs 1 if line + hotfix) | Rust V14 hotfix: `if marketplace != release_signer { marketplace.require_auth(); }` — if same signer, authentication already happened via release_signer.require_auth. Maintains same security. |
| Replay attack: attacker has access to old marketplace initialize signature → recovers authority | Low (Soroban Auth is nonced per ledger) | High | Soroban's implicit nonce pair is sufficient. ADR0002 §3.2 already covers. |

---

## 4. Validation (P0-1 Security Checklist 100% Complete)

- [x] Rust test: `create_escrow` without `requester.require_auth()` removed. `requester.require_auth()` positioned after `executor.require_auth()` [lib.rs L314](file:///home/jistriane/TrustGate/TrustGate/contracts/escrow/src/lib.rs#L314-L314).
- [x] DataKey::Marketplace declared [lib.rs L86-88](file:///home/jistriane/TrustGate/TrustGate/contracts/escrow/src/lib.rs#L86-L88).
- [x] initialize 3 args + marketplace.require_auth() saved separately in DataKey::Marketplace.
- [x] confiscate() compares against DataKey::Marketplace now (not ReleaseSigner). New error: `EscrowError::MarketplaceNotAuthorized` (previously used `NotReleaseSigner` — confusing name).
- [x] TypeScript bindings Client.initialize updated marketplace (not pauser): [client.ts L41](file:///home/jistriane/TrustGate/TrustGate/src/contracts/bindings/escrow/src/client.ts#L41-L46).
- [x] Jest binding ISO 2 tests `initialize-binding.test.ts` + `ourOwnEscrow.initialize_marketplace_arg` in escrowService.ourown.test.ts.
- [x] deploy-escrow.ts ensureInitialized 6 params (previously 5): now accepts marketplace non-null, passed as 3rd arg in shell command.
- [x] .env.example BLOCK N documents MARKETPLACE_WALLET + MARKETPLACE_SECRET_KEY.

---

## 5. Verification (The 4 Architect Questions)

**(1) Meets business objectives?** ✅ Yes.
- GAP P0-1 30% requester share theft — CLOSED.
- Improved operability: release_signer secure OFFLINE; marketplace ONLINE automatic 24/7 confiscation.

**(2) Complies with constraints (technical/budgetary/regulatory)?** ✅ Yes.
- 0 new libs. 0 extra cost. Just DataKey reorganization.
- Separate roles = better internal compliance (separation of duties between release_signer treasury vs marketplace SRE operation).

**(3) Quality attributes?** ✅ Security ↑↑, Operability ↑, Maintainability ↑ (less collapsed coupling of 2 roles).

**(4) CHEAPEST / LEAST risky option?** ✅ Option B (chosen) has best Cost/Risk Ratio. Option A (old) is cheap but **puts all funds at P0 risk**. Option C is expensive and adds no value in MVP.

---

## 6. Post-ADR Consequences

| Area | Expected Change |
|------|------------------|
| Rust Contract | initialize() binary signature broken. Anyone who deployed old testnet needs to re-deploy (Option C contracts are IMMUTABLE — rollback strategy via ADR 0004). |
| TS Bindings | `initialize(token, release_signer, pauser?)` → `initialize(token, release_signer, marketplace)` (3rd arg now mandatory). 2 ISO tests catch regression. |
| Deploy Scripts | deploy-escrow.ts ensureInitialized signature went from 5 params → 6 params (includes marketplace non-null). |
| Env var docs | .env.example BLOCK N documents all escrow runtime variables (previously scattered inline). |
| Security Docs (ADR 0003 L1 checklist) | New mandatory item: "11. create_escrow requires executor AND requester require_auth; does not accept spoof". |

---

## 7. Official Testnet SDF Deploy (06/08/2026)

| Field | Value |
|---|---|
| **Deploy Date** | 2026-08-06 |
| **Escrow Option C Contract ID (3-args initialize)** | `CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH` |
| **Escrow WASM Hash (ADR0008 hotfix)** | `f89ae648…` (release build, 14 KB) |
| **ReleaseSigner = Marketplace (staging same address)** | `GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI` |
| **Stellar Expert Explorer Link** | [🔗 Escrow Contract CB3XTP…7YLH](https://stellar.expert/explorer/testnet/contract/CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH) · [🔗 Admin Wallet](https://stellar.expert/explorer/testnet/account/GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI) |
| **Storage Validation** | ✅ Re-invoke `initialize` → `Error(Contract, #15)` = `AlreadyInitialized` → Token / ReleaseSigner / Marketplace / Pauser / IsPaused written correctly. |
| **Staging rule applied** | `if marketplace != release_signer { marketplace.require_auth() }` → Same address = 1 single require_auth avoids `Existing auth entry`. |
| **Correlated ADR** | [ADR0008 token.require_auth Removal](../0008-remocao-token-require-auth-initialize-p0-sac-usdc-testnet.md) |
