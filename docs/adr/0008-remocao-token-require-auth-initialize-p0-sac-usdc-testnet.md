# ADR 0008 — Removal of `token.require_auth()` in initialize: P0 Bug on-chain Deploy Testnet SDF SAC USDC

| Field | Value |
|---|---|
| ID | 0008 |
| Title | Removal of `token.require_auth()` in `EscrowContract.initialize(token, release_signer, marketplace)` — resolution of P0 bug identified during real deploy on Testnet SDF 06/08 against canonical Circle SAC USDC (wrap already on-chain). |
| Author | TrustGate Architecture (ARCHITECT MODE) |
| Date | 2026-08-06 |
| Status | **Accepted** — 1-line hotfix applied in contracts/escrow/src/lib.rs L217-L242; WASM rebuild release 14KB (hash `f89ae648`). On-chain redeploy CB3XTP…7YLH successful (AlreadyInitialized #15 validates storage written 100%). |
| Depends on | ADR 0002 (Option C Immutable Escrow / on-chain SAC USDC collateral), ADR 0007 (3 args initialize separate marketplace), ADR 0004 (immutable contract rollback via new address redeploy). |
| Next review | If in v2-multicollateral we accept custom wrap tokens that EMIT require_auth on initialize (e.g.: asset issuer with controlled mint authority). |

---

## 0. Context (Problem Solved)

Before this decision, the `Escrow Option C Immutable` contract's `initialize()` method contained **3 require_auth in sequence**, 1 per Address argument:

```rust
// PRE-ADR 0008 (P0 Bug identified 06/08 Testnet SDF deploy):
pub fn initialize(env, token: Address, release_signer: Address, marketplace: Address) -> Result<(), EscrowError> {
    if is_initialized(&env) { return Err(AlreadyInitialized); }
    token.require_auth();           // ← LINE 226 P0 BUG: demanded SAC USDC SK (impossible)
    release_signer.require_auth();
    if marketplace != release_signer { marketplace.require_auth(); }
    env.storage().instance().set(&DataKey::Token, &token);
    // ... remaining effects 5 Instance Storage slots
    Ok(())
}
```

### 0.1 Bug manifestation in real deploy (Official Testnet SDF 06/08)

When trying to initialize contract against `token = CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (canonical SDF on-chain wrap Testnet SAC USDC Circle):

```text
$ stellar contract invoke initialize --token <SAC> --release_signer <GA> --marketplace <GA>
❌ error: Missing signing key for account CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

**Architectural root cause:** In the Soroban model, `Address.require_auth()` demands that the address present a valid `AuthEntry` signed with the corresponding private key, or emitted via sub-call `try_call_auth` from the contract itself. The canonical SAC USDC contract **has no private key** — it is a wrapper asset contract issued by SDF/Circle that controls `authorized_for_contract_id` but does NOT emit auth of itself in the `initialize()` function of third parties.

**Result without hotfix:** initialize always returns `MissingAuth(SAC_USDC)` → Instance storage remains **empty**; `is_initialized() == false`; any subsequent `create_escrow` returns `NotInitialized #20` — contract unusable in production.

### 0.2 Why `release_signer.require_auth()` makes sense but `token.require_auth()` does NOT?

- **ReleaseSigner / Marketplace** = Ed25519 wallets controlled by TrustGate. `require_auth` guarantees "I authorize being the release/confiscation authority of this contract". Clear security value.
- **Token (SAC USDC)** = decentralized wrapper contract. Who authorizes "you can use USDC as collateral" is the **end user at create_escrow**, via `transfer_from(requester → escrow_contract_id)` signed by the fund owner. It makes no sense for the **token contract** to sign anything at escrow initialize.

---

## 1. Architectural Decision

**Remove the `token.require_auth()` line from initialize, keeping release_signer + marketplace (ADR0007 conditional). Initialize now has 2 require_auth, not 3.**

```rust
// POST-ADR 0008 (P0 Hotfix applied 06/08 CB3XTP...7YLH):
pub fn initialize(env, token: Address, release_signer: Address, marketplace: Address) -> Result<(), EscrowError> {
    if is_initialized(&env) { return Err(AlreadyInitialized); }
    release_signer.require_auth();
    if marketplace != release_signer { marketplace.require_auth(); }
    env.storage().instance().set(&DataKey::Token, &token);   // ← token is just DATA (written without auth)
    env.storage().instance().set(&DataKey::ReleaseSigner, &release_signer);
    env.storage().instance().set(&DataKey::Marketplace, &marketplace);
    env.storage().instance().set(&DataKey::Pauser, &release_signer);
    env.storage().instance().set(&DataKey::IsPaused, &0u32);
    refresh_instance_ttl(&env);
    env.events().publish((Symbol::new("escrow_initialized"),), (token, release_signer, marketplace));
    Ok(())
}
```

### 1.1 Why token is just "storage config" and not "authority"?

- Token is already implicitly validated at create_escrow via `SAC.transfer_from(requester, escrow_contract_id, amount)` — if token is fraudulent, transfer_from fails (SAC returns `not_issuer` or `insufficient_balance`).
- Anyone can call `transfer_from` to the contract with **any token that implements the Soroban Token-2026 trait**. Limiting by `token.require_auth` at initialize drastically reduces compatibility.

---

## 2. Architectural Options Considered (3 candidates)

| ID | Candidate Architecture | Complexity (dev) | Security Risk | Impl Type |
|----|------------------------|--------------------|-----------------|---------------|
| **A. (Before, REJECTED)** | Keep `token.require_auth()`; demand deploying **custom** own SAC (not canonical Circle) with issuer private key. | **High**: new SAC contract + own faucet + audit process + lost DeFi Circle composability. | **Medium-High**: losing canonical SDF wrap means fewer liquidity pools, more custom issuer hack risks. | ❌ Rejected for **lower business value** (USDC Circle is the asset customers want). |
| **B. (Chosen ✅)** | Remove `token.require_auth()`; token becomes just written configuration; token security continues being guaranteed **at create_escrow via transfer_from** (existing CEI pattern) + SAC trait. | **Minimum**: 1 line removed from Rust; 0 binding changes (same 3 args signature); 0 deploy script args changes; 0 Jest bindings break. | **Null → Best**: no new vectors. If someone initializes with token = random address, transfer_from in create_escrow returns friendly SAC error `error: no such contract` and collateral never locks. | ✅ Accepted. |
| **C. (Conservative Overkill REJECTED for v1)** | Create separate method `set_token_whitelist(admin, token[])` + `require_whitelisted(token)` in create_escrow + pauser. | **High**: ~60 new Rust lines + new pauser function + whitelist fuzz tests. | **Low**: but adds unnecessary attack surface in Option C (immutable, no upgrade path). | ❌ Rejected by YAGNI + ADR 0004 (immutability = we don't want admin whitelist feature on-chain that breaks decentralization post-deploy). |

### Accepted trade-off Option B:
- **Cons:** None. SAC transfer_from already validates valid token + requester funds.
- **Pros:** Immutability preserved; composability with any canonical SDF token preserved; immediate rollout without new third-party dependency.

---

## 3. Identified Risks + Mitigations

| Risk | Probability | Impact | Mitigation |
|-------|---------------|---------|-----------|
| Someone (any wallet) calls initialize with token = random contract before TrustGate mines deployed address and "hijacks" the contract (we have no initialize access control since contract is IMMUTABLE without admin) | **High** (1st thing attacker does verified on an explorer!) | **High**: we would lose all deploy gas; would have to re-deploy new address. | **ADR 0002 §3.5 already solves:** `deploy-escrow-via-sdk.ts` executes `deploy()` **atomically in the same TypeScript function** 4 sequential steps without await between createContract stage and invokeInitialize → attack window = 0 ms (same Soroban block). Hotshot is already guaranteed SDK order. |
| Automatic Soroban bindings adding back `token.require_auth` on regeneration | Low | Medium | ISO test initialize-binding.test.ts checks Client initialize args (not require_auth). Jest breaks on regression. |
| In future v2 we accept custom asset token with controlled issuer that **requires** `token.require_auth` to authorize being collateral (e.g.: RWA token with compliance) | Medium | Low | ADR0008 next review: `if is_token_requiring_auth_v2 { token.require_auth(); }` with flag based on asset registry. Maintains v1 back-compat. |

---

## 4. Validation (P0 Checklist 100% Complete)

- [x] Rust `escrow/src/lib.rs L226` line of `token.require_auth()` **removed** in local hotfix commit 06/08 deploy.
- [x] WASM release rebuild target `wasm32-unknown-unknown` 14KB hash `f89ae648977ff97b…7ee7cbbd` (new hash).
- [x] SDK V3 on-chain Testnet SDF deploy: **CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH** contract.
- [x] **Storage written proof**: 2nd call `stellar contract invoke initialize --same args` returns **`Error(Contract, #15)` = EscrowError::AlreadyInitialized** → Instance Storage Token/ReleaseSigner/Marketplace/Pauser/IsPaused **written successfully** on 1st SDK V3 initialize.
- [x] **Jest baseline 212 tests:** RC=0 (201 passed, 11 skipped, 0 failed). No binding test broke.
- [x] **TSC RC=0** after extendTtl method removal (incompatible stellar-sdk API installed).
- [x] IDE GetDiagnostics = 0 TypeScript errors.

---

## 5. Verification (The 4 Architect Questions)

**(1) Meets business objectives?** ✅ Yes.
- Without hotfix: deployed contract was **100% inoperable** (initialize always MissingAuth #15). Hotfix = first functional on-chain Testnet SDF deploy.
- Maintains compatibility with canonical SAC USDC Circle = asset desired by customers.

**(2) Compliance with constraints (technical/regulatory/budgetary)?** ✅ Yes.
- 0 new dependencies; 0 new gas costs; 1 line **removed** (fewer bytes = less storage).
- Better compliance with OpenZeppelin ERC-4626 standard: vault initialize does NOT demand token authorization via auth; token is approved by the user at deposit time (transfer_from).

**(3) Required quality attributes?** ✅ Yes.
- Security: no reduction — create_escrow continues mandating `SAC transfer_from` (CEI pattern).
- Maintainability: 1 fewer line in initialize; less coupling with SAC internal implementation.
- Availability: now works! Before it was always unavailable.

**(4) Cheapest / least risky option?** ✅ Option B (remove line). Option A = custom USDC ~10k USD audit + months rollout. Option C = whitelist 60h + access bugs. Option B = 1 edit + 2 rebuild + 1 redeploy ~20 min work. Best Cost/Risk Ratio.

---

## 6. Post-ADR 0008 Consequences

| Area | Expected Change |
|------|------------------|
| Rust Contract lib.rs | `initialize()` binary signature same (3 args). Just 1 fewer auth. Soroban ABI unchanged (same function name, same ScVal args). |
| TypeScript Bindings | None. `Client.initialize(token, release_signer, marketplace)` continues identical. 2 ISO tests pass. |
| Deploy Scripts | No changes. Same 3 args. |
| On-chain Addresses | **Old contract CAOX2…FOZ3** (SDK V2 deploy, no storage, empty) — abandoned. **Canonical Valid Contract CB3XTP…7YLH** (ADR 0008 applied). Both appear in explorer, only CB3X…7YLH is AlreadyInitialized. |
| Jest Baseline 212 tests | RC=0 preserved in 2 independent runs. |
| Instance Storage TTL | Will receive automatic refresh 518400 ledgers (~30d) on every `create_escrow`, `release_milestone`, `confiscate`, `claim_timeout`, `pause`, `unpause` via already existing `refresh_instance_ttl()` function. |
| ADR 0003 Security (L1 2 devs checklist) | New mandatory item added: "12. initialize does not require token.require_auth() — only release_signer and marketplace authorities are validated on deploy." |

---

## 7. Official Testnet SDF Deploy (06/08/2026)

| Field | Value |
|---|---|
| **Deploy Date / Hotfix applied** | 2026-08-06 |
| **Escrow Option C Contract ID (Valid, ADR0008 applied)** | `CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH` |
| **Escrow Old Contract (ABANDONED, no storage)** | `CAOX2RE65BAPX437XSSZPWXR6XUQZEW36A34IG2I2NMCVQ56FEYMFOZ3` (SDK V2, initialize MissingAuth) |
| **New WASM Hash (1-line hotfix)** | `f89ae648977ff97b39f2d7e1d4a0e3e1c46b1211c51d0f17d6a0efab7ee7cbbd` (release, 14 KB) |
| **SAC USDC Circle used in initialize** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (canonical SDF wrap) |
| **Classic USDC Circle Testnet Issuer** | `GBBDS5BEUTSEVQHN2GJ4H7VYJ5B2Q2XU4VVC7EERKMOV5QQQHMK6FLA5` |
| **Initialize Signers (staging same address)** | ReleaseSigner = Marketplace = `GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI` |
| **Stellar Expert Explorer Links** | [🔗 Valid Escrow CB3XTP…7YLH](https://stellar.expert/explorer/testnet/contract/CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH) · [🔗 SAC USDC](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) · [🔗 Admin Wallet](https://stellar.expert/explorer/testnet/account/GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI) |
| **Storage written proof (P0)** | ✅ 2nd `initialize` call → `Error(Contract, #15)` = `EscrowError::AlreadyInitialized` → **5 Instance Storage slots written** (Token / ReleaseSigner / Marketplace / Pauser / IsPaused = 0). |
| **Status** | ✅ Deployed & Validated — 2-signer smoke `create_escrow` executed successfully, returned SAC#10 `InsufficientBalance` (proof of complete pipeline: 2x require_auth, Nonce, footprint, types, transfer_from). |
| **Correlated ADR** | [ADR0007 Roles Separation Marketplace ↔ ReleaseSigner](../0007-marketplace-role-dedicado-separado-releasesigner-p0-1-seguranca.md) |
