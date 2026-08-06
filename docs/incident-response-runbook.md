# Incident Response Runbook — TrustGate Marketplace

- Version: v1.0 (2026-08-05)
- Owner: Platform Team / On-Call
- Scope: All severities P0, P1, P2. Applies to dev, homolog/staging, production environments.
- Scheduled review: every two weeks, or after each real incident.

---

## 0. Executive Summary (30s — before any action)
TrustGate was designed under the principle: **any less risky action is off-chain first**. We do NOT have on-chain pause by default — the 3 emergency pauses are off-chain env vars, patch deploy in 1 minute.
The 3 "big red buttons" are documented in the README section 7.1, Safety column:

| Button | Effect | Latency to activate | Activation risk |
|-------|--------|---------------------|-------------------|
| `PAUSE_NEW_TASKS=true` | No new POST /tasks creates a new task in the database. Everything else continues. | ~1 min (rolling pod restart) | **Very low** — Does NOT affect existing tasks/bids/worker. |
| `PAUSE_NEW_BIDS=true` | POST /bids/:taskId returns 423 Paused. Old tasks continue processing normally. | ~1 min | **Very low** — only blocks new executor entry. |
| `PAUSE_WORKER_CONSUMPTION=true` | Worker CONTINUES: (a) sampling backlog metrics, (b) writing outbox rows, (c) publishing to Redis Streams. Worker **DOES NOT**: XAUTOCLAIM / poll / dispatching of any event (webhook, release milestone, confiscation, etc.). | ~1 min | **Low — what is done stays done, but worker is idempotent (ADR0001) — XAUTOCLAIM continues after toggle OFF automatically resumes pending events with ZERO data loss. |

Default first-minute action for EVERY P0 payment/collateral/escrow incident:
1. Activate `PAUSE_WORKER_CONSUMPTION=true → save rolling deploy. (This buys 5 to 30 minutes of safe window time. No more events are sent to webhook/escrow/blockchain. Data already keeps arriving in the database and streams.)
2. Save the exact activation time (ISO-8601 UTC).
3. Create a war Slack/Discord channel with prefix `#inc-YYYYMMDD-<number>.

---

## 1. Definitions and Response Times (Internal SLA)

| Severity | Definition (TrustGate examples) | Initial response time | Partial mitigation | Full mitigation |
|-------------|-------------------------------|--------------------------|---------------------|------------------|
| **P0 (CRITICAL)** | IMMINENT loss or risk of funds (USDC/collateral from executor/requester/marketplace) — smart contract vulnerability, release milestone bug without auth, `MARKETPLACE_WALLET_PRIVATE_KEY` leak, forged dispute win webhook exploit. **Or:** worker unavailability for > 60 min during peak hours with > 100 concurrent tasks. | **5 minutes** (on-call on-duty engineer) | 15 minutes (pause worker + pause bids/tasks) | 4 hours |
| **P1 (HIGH)** | Executor authentication bug (bid/task signature forgeable but THERE IS NO FUND RISK), Trustless Work SaaS webhook down for >15 min, degradation > 5xx in 1h, false positive of stopped worker but data not lost. **Or:** non-critical data leak (public metadata, timestamps) | **30 minutes** | 1 hour (pause worker IF necessary) | 1 business day |
| **P2 (MEDIUM)** | UI bug, Prometheus metrics not reporting correctly, isolated warn log, degraded performance but without fund risk, task with erroneous result in rare edge case < 1/10,000 tasks | 4 hours | 1 business day | next release |
| **P3 (LOW)** | Docs typo, isolated TypeScript compilation warning, outdated dependency without CVE, UX improvement | Next sprint | N/A | planned release |

---

## 2. Roles and Responsibilities

| Role | Responsibility | Who (example) |
|-------|-------------------|-------------------|
| **Incident Commander (IC)** | Final decision owner, coordinates communication and timeline, authorizes rollback/forward. 1 per incident, non-negotiable. | Senior Engineer +1 most experienced |
| **Technical Action Executor** | Executes env vars changes / rollback forward. **Does NOT make decisions — follows documented orders from the IC. FOR EACH ACTION.** | Any platform engineer |
| **Communication (Liaison)** | Posts updates every 15 min in the channel; updates statuspage if there are users; notifies support/legal for escrow P0. | Product / PO / Community Manager |
| **Security Reviewer** | P0 involving smart contract / wallet private key | External auditor if retainer + internal TrustGate Architect |

---

## 3. Playbooks by Incident Type (Step-by-Step Action)

### 3-A Playbook P0-1 — Bug in Escrow / Fund Risk (USDC collateral leaking (undue release milestone, undue confiscation, claim_timeout BEFORE 14d — TOP RISK)
**Typical triggers: (a) Alert `tg_escrow_confiscate_total` (metric) spike above baseline 5σ; (b) 2+ user tickets saying "collateral came wrong"; (c) user social proof Twitter / Discord reporting transaction bug "received release without doing task".

**Execution steps (1 action at a time, wait for return confirmation RC=0):**
```
STEP 1 (0-5 min): 3 emergency pauses — activate EVERYTHING (better safe than sorry):
  export NEW_ENV="PAUSE_NEW_TASKS=true PAUSE_NEW_BIDS=true PAUSE_WORKER_CONSUMPTION=true"
  deploy rolling production (kubectl / fly deploy / docker stack deploy, depends on your infra).
  VERIFICATION: curl https://api.trustgate.io/health → body { "workerPaused": true, "newTasksPaused": true, "newBidsPaused": true }
```
```
STEP 2 (5-10 min): Isolating the escrow feature — SWITCH PROVIDER to MOCK (100% safe does not touch blockchain):
  export NEW_ENV="${NEW_ENV} ESCROW_IMPLEMENTATION=mock"
  deploy rolling again (1 min).
  VERIFICATION: boot log → pino warn "[createEscrowProvider] using mock escrow (MOCK_EXTERNALS or ESCROW_IMPLEMENTATION mock"
  BLOCKS NEW createEscrow calls from Trustless work / our contract — everything is local stub does not affect balances.
```
```
STEP 3 (10-15 min): Diagnostics — look at 3 sources:
  (a) Last 500 outbox events in public.outbox table with status = 'DISPATCHED' and created_at > (now-2h)
  (b) pino error logs → grep for createEscrow / releaseMilestone / confiscate ERROR* with correlation_id
  (c) If it's our Option C contract: run script scripts/forknet-claim_timeout-test.ts --inspect transaction
```
```
STEP 4 (15 min+): Rollback vs Roll-forward Decision:
  IC decides. Rollback: revert the last release commit 1 hour ago → deploy stable version; Roll forward: hot-fix patch correction PR + tests.
  ANY code roll forward involving escrow: MANDATORY 2 engineer approvals + test in staging before production.
```
```
STEP 5 (final): Compensation $ calculation for affected users; communication; post-mortem in docs/postmortems/INC-YYYYMMDD-N.md
```
```
STEP 6 (final final): Deactivate 3 pauses gradually: first worker, then bids, lastly tasks.
```

### 3-B Playbook P0-2 — Leak / Suspicion of `MARKETPLACE_WALLET_PRIVATE_KEY` (NIGHTMARE SCENARIO)
Trigger: S3 / GitGuardian / Secret Scanner alert detected key in commit, or engineer realizes they pasted it in chat, or on-chain transaction log shows undue wallet output without our signature.
**Steps:**
1. IMMEDIATELY (60 seconds): Transfer ALL USDC balance from the hot wallet to multisig cold wallet — offline signature. Do not leave 1 USDC in the wallet.
2. New `MARKETPLACE_WALLET_PUBLIC_KEY` = generate NEW key (scripts/setup-dev-wallet.ts --prod).
3. Revoke ALL PAT tokens on GitHub; Change all deploy account keys.
4. Notify vendors (Trustless Work): new release_signer new key.
5. Re-deploy.
6. Apply DENYLIST with the old key (because `EXECUTOR_DENYLIST=<old_key> so it does not receive bids from the old key.

### 3-C Playbook P1-1 — Worker Stuck, Redis Stream stopped XPENDING grows indefinitely (consumer-group / Backlog
Trigger: Alert `trustgate_stream_pending_backlog critical 1000+ >5m.
90% likely causes: (a) previous deploy worker pod without graceful shutdown; (b) Redis maxlen overflow; (c) payload deserialization bug causing worker loop locked 1 consumer; (d) OOM kill of the pod.
Steps:
1. If `PAUSE_WORKER_CONSUMPTION=true if backlog already has new events entering but not being claimed; ADR0001 outbox idempotent, it does).
2. `XRESET consumer groups info consumers `XINFO GROUPS <stream> → check pending delivery count = 10000.
3. `XAUTOCLAIM manual claim of 100 in 100 with scripts/worker-backfill.ts)
4. deploy restart worker pods.
5. Toggle `PAUSE_WORKER_CONSUMPTION=false` back.

### 3-D Playbook P1-2 — SaaS Trustless Work down / 5xx for > 10+ webhook failing
Steps:
1. Check Trustless Work status → contact them 24/7 channel (see SLA contract item 2 mandatory P0-A)
2. PAUSE_WORKER_CONSUMPTION=true worker does not try to deliver.
3. Switch ESCROW_IMPLEMENTATION=mock ONLY new tasks/bids; existing tasks will wait for TrustlessWork normal resumption.

---

## 4. Rollback Procedure (THREE ROLLBACK OPTIONS):

| Level | Method | Time to activate | Use |
|---------|--------|-----------------|--------|
| Level 1 (Light | Undo) | Change env var SAFEST customer-aware |
|   |undo emergency unpause undo. | ~1 min | None of the 3 pauses deactivate) | Any P0 symptom P>|
| Level 2 (Medium) | Docker image rollback to previous tag (last release | ~3-5min | strategic rollout deploy without code worked 2+ commits ago) | Buggy code rollback |
| Level 3Severe — Data | Postgres PITR Snapshot Restore (point-in-time recovery) | 15-30 min | Database Worst case. Database rollback + restore snapshot `pg_dump last good before incident. Always do CHECKSUM sha256 before before restoring validate dump integrity. |

⚠️ NEVER run rollback OF SEVERE database contract OUTSIDE the incident. 2 approvals.

---

## 5. Post-Mortem Template (Every severity ≥ P1 has Post-Mortem:
1. Timeline in new markdown `docs/postmortems/INC-YYYYMMDD-N.md.
2. Mandatory content:
   - Summary (3 sentences).
   - Impact: how many users, how much $$, duration.
   - Timeline with timestamps) actions.
   - Root cause (5-Whys).
   - Corrective actions short (1 week) and term.
   - Long-term preventive measures + owner.
   - Lessons learned).
3. Reviewed by team in 7 days.

---

## 6. Contacts (Team and Vendors (P0):
| Entity (P0 contact name / SLA response channel |
|---|
| 2777 55 | Primary OnCall IC 15 min)
| Trustless Work Custodian 24/7 +44-XXX@trustless.io — SLA 20 (contract item P0-A). External Auditor Retainer 24/7 response 2h to analyze smart contract bug (annual paid retainer). |
| Stellar Org Support Discord `#dev-support` public for Soroban pubnet incidents) |

---

## 7. Runbook Validation (biweekly checklist — test):
- [ ] All 3 off-chain pauses work test in homolog during lowest traffic hours?
- [ ] Image rollback (deploy rollback (5 min in homolog.
- [ ] Postgres snapshot restore restore dump successfully in staging environment.
- [ ] ESCROW_IMPLEMENTATION switch trustlesswork → mock → back.
- [ ] New wallet setup works (setup-dev-wallet.ts --dry-run).
- [ ] ADR0001 backfill scripts? XPENDING Backlog 100 idempotent events?
- [ ] 24-7 Trustless Work contact responded ping test?
- [ ] Last Post-Mortem has corrective actions closed.

---

## 8. Quick Links (Safety Copy)

### 8.1 Deployed On-Chain Contracts (Testnet SDF — 06/08/2026)
| Asset | Address | Stellar Expert Explorer Link |
|---|---|---|
| **Wallet Admin / Marketplace** | `GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI` | [Open Explorer](https://stellar.expert/explorer/testnet/account/GAE7YLEM2X2WJQVR6ZOM6TYTBRZ5Y7T3I2VZPN2XJKQSLH2C5CDPVLPI) |
| **Registry v2 (Immutable)** | `CAC752B34ZYHHDTSHDVVHY3IX2R2UQHAN4AY5B57NZUY23XCYIEXSGPP` | [Open Explorer](https://stellar.expert/explorer/testnet/contract/CAC752B34ZYHHDTSHDVVHY3IX2R2UQHAN4AY5B57NZUY23XCYIEXSGPP) |
| **Escrow Option C (ADR0008 hotfix)** | `CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH` | [Open Explorer](https://stellar.expert/explorer/testnet/contract/CB3XTPXXXF4JSHZBY4S7F3BFD4JZPUVNHDWSDQ7L2JKDUWSK7VBL7YLH) |
| **SAC USDC Circle (canonical wrap)** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | [Open Explorer](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |

**WASM Hash Escrow (ADR0008):** `f89ae648…` (release build, 14KB).  
**P0 fast diagnostics:** re-invoke `initialize` on Escrow → expected `Error(Contract, #15)` = `AlreadyInitialized` (proves storage saved).

---

### 8.2 ADRs and Code Files
- ADR0001 Outbox Worker (idempotency + backlog): [adr/0001-outbox-worker-idempotency.md](file:///home/jistriane/TrustGate/TrustGate/docs/adr/0001-outbox-worker-idempotency.md)
- ADR0002 On-chain Strategy + Off-chain Pauses: [adr/0002-on-chain-strategy-registry-immutable-escrow-saas.md](file:///home/jistriane/TrustGate/TrustGate/docs/adr/0002-on-chain-strategy-registry-immutable-escrow-saas.md)
- ADR0007 Roles Separation Marketplace ↔ ReleaseSigner: [adr/0007-marketplace-role-dedicado-separado-releasesigner-p0-1-seguranca.md](file:///home/jistriane/TrustGate/TrustGate/docs/adr/0007-marketplace-role-dedicado-separado-releasesigner-p0-1-seguranca.md)
- ADR0008 Hotfix token.require_auth initialize: [adr/0008-remocao-token-require-auth-initialize-p0-sac-usdc-testnet.md](file:///home/jistriane/TrustGate/TrustGate/docs/adr/0008-remocao-token-require-auth-initialize-p0-sac-usdc-testnet.md)
- Registry Contract: [contracts/registry/src/lib.rs](file:///home/jistriane/TrustGate/TrustGate/contracts/registry/src/lib.rs)
- Own Escrow Contract (Option C): [contracts/escrow/src/lib.rs](file:///home/jistriane/TrustGate/TrustGate/contracts/escrow/src/lib.rs)
- Safety Operation Environment Vars: [README Safety section](../README.md#environment-variables)
- Prometheus Alerts: `prom/alerts/trustgate-alerts.yml`
- Grafana Dashboards: `grafana/dashboards/`
