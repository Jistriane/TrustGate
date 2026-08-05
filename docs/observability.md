## Observability (TrustGate)

This document is a practical runbook for diagnosing issues using Prometheus metrics exposed at `GET /metrics`.

### Setup (Grafana + Prometheus)

**Grafana dashboards**

- Dashboards live in `grafana/dashboards/`:
  - `trustgate-auth-overview.json`
  - `trustgate-worker-overview.json`
- They use a datasource variable named `DS_PROMETHEUS`.
  - When importing, pick your Prometheus datasource for this variable.

**Prometheus alert rules**

- Alert rules live in `prom/alerts/trustgate-alerts.yml` (two groups: `trustgate-auth`, `trustgate-worker`).
- How to load:
  - Add it to your Prometheus config under `rule_files`, for example:

```yml
rule_files:
  - /etc/prometheus/alerts/trustgate-alerts.yml
```

Then mount/copy `prom/alerts/trustgate-alerts.yml` into that path in your Prometheus deployment.

**Before every deploy — run the baseline verifier**

```bash
bash scripts/observability-baseline.sh           # full stack + smoke + metrics + prom + grafana
bash scripts/observability-baseline.sh --keep    # keep the stack alive after success to explore manually
```

This script fails hard (`set -euo pipefail`) when any of the following regress: alert rules YAML structure, Grafana dashboard JSON structure, app/prom/grafana health, signed-request smoke (`/auth/nonce` → `/auth/signed-smoke` with a freshly generated `Keypair`), presence of required core metrics in `/metrics`, and loading of `trustgate-auth` / `trustgate-worker` rule groups in Prometheus. See [README baseline section](file:///home/jistriane/TrustGate/TrustGate/README.md#L668-L734).

### Local stack (Docker Compose)

You can run Prometheus + Grafana locally (and have Prometheus scrape the app) by starting the main stack and the observability stack together:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up --build -d
```

- App metrics: `http://localhost:3000/metrics`
- Prometheus UI: `http://localhost:9090`
- Grafana UI: `http://localhost:3001`
- Dashboards provisioned automatically as anonymous Viewer at `/dashboards`.

### Auth (signed requests)

**Key metrics**

- `tg_auth_nonce_requests_total{status}`
- `tg_auth_nonce_latency_ms{status}`
- `tg_auth_signature_requests_total{status,route}`
- `tg_auth_signature_latency_ms{status,route}`
- `tg_auth_signature_failures_total{reason,route}`

**Alerts / symptoms**

- Spike in `tg_auth_signature_requests_total{status="401"}` (per route)
  - Likely cause: client-side canonical payload mismatch, replayed nonce, missing headers.
  - Action:
    - Check `tg_auth_signature_failures_total{reason,route}` for the top failure reason.
    - Validate client is calling `POST /auth/nonce` per request and not reusing nonce/timestamp.
    - Validate the signed `PATH` excludes query string and matches the server route exactly.

- Spike in `tg_auth_signature_requests_total{status="429"}` (per route)
  - Likely cause: repeated failing auth attempts from a buggy client or abuse.
  - Action:
    - Identify which route is affected.
    - Confirm whether this is expected load testing; otherwise investigate client rollout.
    - Consider adding per-IP WAF rules if the traffic is untrusted.

- Latency increase in `tg_auth_nonce_latency_ms`
  - Likely cause: Redis latency/availability issues.
  - Action:
    - Check Redis health/CPU/memory and network.
    - If Redis is degraded, signed requests may fail (nonce issuance and nonce consumption).

### Worker / Outbox

**Key metrics**

- `tg_worker_tick_total{status}`
- `tg_worker_tick_latency_ms{status}`
- `tg_outbox_publish_events_total{result}`
- `tg_outbox_unprocessed`
- `tg_outbox_failed`
- `tg_worker_autoclaim_entries_total`
- `tg_worker_poll_entries_total`
- `tg_worker_dispatch_total{type,result}`
- `tg_worker_due_retries{handler}`
- `tg_stream_length{stream,group}`
- `tg_stream_pending{stream,group}`
- `tg_stream_pending_consumer{stream,group,consumer}`

**Alerts / symptoms**

- `tg_worker_tick_total{status="error"}` increases
  - Likely cause: dependency failure (Redis/DB/webhook) or unhandled runtime error.
  - Action:
    - Check logs around `[Worker] tick failed`.
    - Confirm Redis and Postgres availability.
    - If the failing type is only `result_published`, suspect webhook endpoint failures.

- `tg_outbox_publish_events_total{result="failed"}` increases
  - Likely cause: Redis stream write failures or transient issues.
  - Action:
    - Inspect Redis health and connectivity.
    - Ensure stream key is correct and Redis has enough memory.
    - Verify outbox rows marked failed in Postgres (so you can reprocess or investigate).

- `tg_worker_due_retries{handler}` stays > 0 for long periods
  - Likely cause: persistent failure in a handler, or stuck dependency.
  - Action:
    - Compare with `tg_worker_dispatch_total{type,result="failed"}` to identify which event type is failing.
    - For `task_completion_requested`, validate Trustless Work connectivity/credentials.
    - For `result_published`, validate the webhook URL and downstream service availability.

- `tg_worker_tick_latency_ms` increases and `tg_worker_poll_entries_total` stays low
  - Likely cause: tick is blocked on slow I/O (webhook, escrow, DB).
  - Action:
    - Identify which handler is slow by checking application logs and downstream latencies.
    - Consider increasing `WORKER_POLL_MS` to reduce pressure, or adding timeouts/circuit breakers for external calls.

**Stream backlog (XLEN / PENDING / per-consumer PEL) — how to read**

These three gauges tell different stories — don't treat them as interchangeable:

| Gauge | Redis command | Meaning in TrustGate | When to worry |
|-------|---------------|----------------------|---------------|
| `tg_stream_length{stream,group}` | `XLEN tg:events` | Total number of entries still sitting in the stream (includes entries not yet delivered). | Sustained monotonic growth → producer is out-pacing consumers. |
| `tg_stream_pending{stream,group}` | `XPENDING tg:events tg-workers - + COUNT summary` | Number of entries **delivered but not yet `XACK`ed** (Pending Entries List total). | Growth without commensurate `XACK` rate → handlers slow/erroring before ack. |
| `tg_stream_pending_consumer{stream,group,consumer}` | `XPENDING tg:events tg-workers - + COUNT per consumer` | PEL broken down by consumer name. Cardinality bounded by number of workers (1–16). | One consumer has a PEL order-of-magnitude higher than peers → consumer stuck, network partition, or `XAUTOCLAIM` hasn't run yet. |
| `tg_outbox_unprocessed` | Postgres `SELECT COUNT(*) FROM outbox_events WHERE processed_at IS NULL` | Rows persisted but not yet `XADD`ed to the stream (publisher lag). | > 0 for long → outbox publisher is failing (Redis issues). |
| `tg_outbox_failed` | Postgres `SELECT COUNT(*) FROM outbox_events WHERE processed_at IS NULL AND attempts > 0` | Publisher retried at least once but never succeeded. | Any growth → Redis stream write failures; need infra triage. |

Backlog sampling runs every **5 s** inside the worker tick (separate from per-tick processing to avoid disturbing hot paths).

**Growing backlog alerts / symptoms**

- `tg_stream_pending` and `tg_outbox_unprocessed` both grow:
  - Likely cause: worker is stuck or Redis is throttling `XREADGROUP`.
  - Action: follow the [Worker stuck P0 runbook](#p0-worker-stuck--not-ticking); if only one consumer in `tg_stream_pending_consumer` is elevated, check `XAUTOCLAIM` has transferred its PEL to healthy workers.

- Only `tg_stream_pending_consumer{consumer=<name>}` is elevated (rest are low):
  - Likely cause: one worker instance crashed without graceful shutdown or is network-partitioned from Redis.
  - Action: confirm the worker process exists; if dead, `XAUTOCLAIM` should recover entries within ~2 idle-time thresholds; force a restart of the remaining workers or add a temporary dedicated dead-letter triage step.

- Only `tg_outbox_failed` grows:
  - Likely cause: Redis `XADD` failing consistently.
  - Action: immediate Redis triage per [P0 Redis runbook](#p0-redis-down--degraded).

### Minimal dashboards (suggestions)

- **Auth Overview**
  - 401 rate by `route`
  - 429 rate by `route`
  - Top `reason` in `tg_auth_signature_failures_total`
  - p95 of `tg_auth_nonce_latency_ms`

- **Worker Overview**
  - Tick error rate and tick p95 latency
  - Outbox publish failures
  - Dispatch failures by `type`
  - Due retries by `handler`

### SLOs & thresholds (v1)

These are initial, conservative thresholds to reduce MTTR and catch regressions early. Adjust once you have real traffic baselines.

#### Auth SLOs (server-side)

**Nonce issuance availability**

- **Goal (SLO)**: `POST /auth/nonce` success rate ≥ 99.9% over 30d.
- **Signal**:
  - Success: `tg_auth_nonce_requests_total{status="200"}`
  - Errors: `tg_auth_nonce_requests_total{status=~"5.."}`
- **PromQL** (error ratio, 5m window):
  - `sum(rate(tg_auth_nonce_requests_total{status=~"5.."}[5m])) / sum(rate(tg_auth_nonce_requests_total[5m]))`
- **Suggested alert**:
  - Warning: > 0.5% for 5m
  - Critical: > 2% for 5m

**Nonce latency**

- **Goal (SLO)**: p95 `POST /auth/nonce` latency < 250ms.
- **PromQL** (p95, 5m window):
  - `histogram_quantile(0.95, sum(rate(tg_auth_nonce_latency_ms_bucket[5m])) by (le))`
- **Suggested alert**:
  - Warning: p95 > 500ms for 10m
  - Critical: p95 > 2000ms for 5m

**Client error noise (not an SLO, but an anomaly detector)**

- **Spike 401** by route may indicate client rollout issues:
  - `sum(rate(tg_auth_signature_requests_total{status="401"}[5m])) by (route)`
- **Spike 429** by route may indicate abuse or misbehaving clients:
  - `sum(rate(tg_auth_signature_requests_total{status="429"}[5m])) by (route)`

#### Worker SLOs (liveness & delivery)

**Tick liveness**

- **Goal (SLO)**: `tg_worker_tick_total{status="success"}` continues increasing.
- **PromQL** (no-success-ticks detector, 2m window):
  - `increase(tg_worker_tick_total{status="success"}[2m]) == 0`
- **Suggested alert**:
  - Critical: no successful ticks for 2m

**Tick errors**

- **Goal (SLO)**: tick error ratio < 1% over 30d (best-effort; depends on external dependencies).
- **PromQL** (error ratio, 5m window):
  - `sum(rate(tg_worker_tick_total{status="error"}[5m])) / sum(rate(tg_worker_tick_total[5m]))`
- **Suggested alert**:
  - Warning: > 5% for 10m
  - Critical: > 20% for 5m

**Tick latency**

- **Goal (SLO)**: p95 tick duration stays under the configured `publishIntervalMs` budget (if `publishIntervalMs <= 1s`, start with p95 < 2000ms).
- **PromQL** (p95, 5m window):
  - `histogram_quantile(0.95, sum(rate(tg_worker_tick_latency_ms_bucket[5m])) by (le, status))`
- **Suggested alert**:
  - Warning: p95 > 2000ms for 10m
  - Critical: p95 > 10000ms for 5m

**Outbox publish failures**

- **Goal (SLO)**: publish failures are rare; sustained failures mean Redis issues.
- **PromQL** (failure rate, 5m):
  - `sum(rate(tg_outbox_publish_events_total{result="failed"}[5m]))`
- **Suggested alert**:
  - Warning: > 0 for 5m
  - Critical: > 1/s for 5m

**Due retries**

- **Goal (SLO)**: `tg_worker_due_retries{handler}` stays at 0 most of the time.
- **PromQL**:
  - `max(tg_worker_due_retries) by (handler)`
- **Suggested alert**:
  - Warning: > 0 for 10m
  - Critical: > 10 for 10m

**Stream backlog (XLEN + PENDING)**

- **Goal (SLO)**: stream size and PEL size are bounded, and do not grow unboundedly even under 2× peak input.
- **PromQL (growing PEL detector)**:
  - `increase(tg_stream_pending[10m]) > 100` — pending entries grew by >100 in 10 minutes.
- **PromQL (growing unprocessed outbox detector)**:
  - `increase(tg_outbox_unprocessed[10m]) > 50`
- **PromQL (per-consumer stuck PEL)**:
  - `max by (consumer) (tg_stream_pending_consumer) > 100 and on (consumer) (tg_stream_pending_consumer offset 5m) > 100` — same consumer has >100 pending entries for >5 minutes (not draining).
- **Suggested alerts**:
  - Warning: `tg_stream_pending > 100` for 10m OR `tg_outbox_unprocessed > 50` for 10m
  - Critical: `tg_stream_pending > 1000` for 5m OR `tg_outbox_failed > 0` for 5m
  - Warning (per-consumer stuck): `tg_stream_pending_consumer{consumer} > 100` AND has not decreased in 5m

**Outbox failed (sustained)**

- **Goal (SLO)**: `tg_outbox_failed` stays strictly 0 (any failed means the stream publisher cannot even retry).
- **PromQL**:
  - `tg_outbox_failed > 0`
- **Suggested alert**:
  - Critical: `tg_outbox_failed > 0` for 2m (no acceptable duration for a stuck failed stream publisher)

### Incident runbook (P0/P1)

This section is a high-signal operational playbook. It is intentionally short and action-oriented.

#### P0: Redis down / degraded

**Detection**

- `/health/detailed` reports Redis down, or Prometheus alerts fire:
  - `/auth/nonce` 5xx ratio / latency spike
  - outbox publish failures
  - worker tick errors

**Impact**

- Signed requests may fail (nonce issuance + nonce consumption).
- Worker may fail to publish/consume outbox events.

**Immediate actions**

1) Confirm the failure scope:
   - Check Redis container/service status.
   - Check network connectivity from app to Redis.
2) Mitigate:
   - Restart Redis if it is unhealthy (prefer rolling restart in production).
   - If Redis is OOM/evicting keys, increase memory or adjust eviction policy.
3) Validate recovery:
   - `/health/detailed` returns `redis: up`.
   - `tg_auth_nonce_requests_total{status="200"}` resumes and latency drops.
   - `tg_outbox_publish_events_total{result="failed"}` stops increasing.

**Aftercare**

- Confirm no drift in worker behavior (tick latency/backlog).
- If Redis outage was prolonged, expect some client retries; watch 401/429 spikes.

#### P0: Worker stuck / not ticking

**Detection**

- Alert: no successful ticks for 2m, or tick p95 latency > 10s.

**Impact**

- Outbox delivery and async completion may be delayed:
  - task escrow releases may be delayed (tasks can remain `COMPLETING` longer).
  - webhooks may be delayed.

**Immediate actions**

1) Confirm process health:
   - Check worker logs for `[Worker] tick failed`.
   - Verify DB and Redis are reachable.
2) Mitigate:
   - Restart the worker process (safe due to idempotency via `event_consumptions`).
   - If the worker is CPU-starved, increase CPU or reduce `publishIntervalMs`.
3) Validate recovery:
   - `tg_worker_tick_total{status="success"}` increases again.
   - Dispatch failures stop increasing.

**Aftercare**

- Monitor due retries (`tg_worker_due_retries`) for persistent failures.
- If failures are only `result_published`, validate webhook endpoint availability.

#### P1: Spike in 401 (signed auth) after client rollout

**Detection**

- Spike in `tg_auth_signature_requests_total{status="401"}` (by route), often with top reasons:
  - `invalid signature`, `invalid nonce`, `timestamp outside allowed window`

**Immediate actions**

1) Identify the impacted route(s) and top failure reasons:
   - `topk(10, sum(rate(tg_auth_signature_failures_total[5m])) by (reason, route))`
2) Validate the client contract:
   - Nonce is one-time and fetched per request.
   - Canonical payload includes the exact `PATH` (no query string).
   - Body hash uses the exact JSON string sent in `fetch`.

**Mitigation**

- Roll back the client release if most traffic is failing.
- If abuse is suspected, apply WAF/rate limits at the edge.

#### P0: Safe rollback procedure

This is a conservative rollback checklist intended to be followed even under pressure. Prefer rolling back the smallest possible surface area.

**Goals**

- Stop the incident blast radius fast.
- Avoid making data integrity worse (double side-effects).
- Restore service health signals (`/health/detailed`, worker ticks, outbox publish).

**Pre-flight**

1) Confirm the symptom and scope:
   - Which alert fired (auth nonce, worker ticks, outbox failures)?
   - Which routes/types are impacted?
2) Prefer rolling back the client first when the symptom is auth noise (401/429 spikes).
3) Confirm idempotency protection is in place:
   - Worker uses `event_consumptions` (safe to restart/reprocess).
4) Snapshot current state for incident notes:
   - current deploy version/commit, timestamp, and active alerts.

**Rollback execution**

1) Roll back one component at a time (in order):
   - client (if applicable) → API → worker
2) For API/worker, do rolling restart to keep some capacity online (when possible).
3) Do not disable security controls (auth/rate limits) as a “fix”; treat that as last resort with explicit approval.

**Post-rollback validation (must pass)**

- `GET /health` is 200.
- `GET /health/detailed` shows `redis: up` and `stellarRpc: up` (and DB up when configured).
- `tg_worker_tick_total{status="success"}` resumes increasing.
- `tg_outbox_publish_events_total{result="failed"}` stops increasing.
- Auth signals stabilize:
  - `tg_auth_nonce_requests_total{status="200"}` resumes.
  - 401/429 rates return to baseline (or drop materially).

**Aftercare**

- If the rollback fixed it, open a follow-up issue for root cause and add a regression test if applicable.
- If the rollback did not fix it within one cycle, stop and reassess the hypothesis; avoid serial “random” rollbacks.

#### P0: Postgres down / degraded

**Detection**

- `/health/detailed` reports DB down (when configured), or worker shows tick errors.
- Symptoms:
  - API endpoints that require persistence fail with 5xx (especially on non-local networks).
  - Worker retries increase and/or tick errors rise.

**Impact**

- State-changing requests may fail (repository writes).
- Outbox publishing may stall if new events cannot be persisted or marked processed.
- Retry bookkeeping (`event_consumptions`) may fail, increasing duplicate work risk (though handlers are designed for idempotency).

**Immediate actions**

1) Confirm the failure scope:
   - Check Postgres container/service status and logs.
   - Verify connectivity from app/worker to Postgres.
2) Mitigate:
   - Restart Postgres if unhealthy (prefer rolling/manged procedures in production).
   - If saturation, increase connections/CPU/IOPS or reduce load.
   - If migrations were recently applied, verify schema compatibility.
3) Validate recovery:
   - DB connectivity is restored.
   - Worker ticks recover (`tg_worker_tick_total{status="success"}` increases).
   - Outbox publish failures stop increasing.

**Aftercare**

- Inspect DB metrics (connections, slow queries) and ensure pooling settings are sane.
- If the incident coincided with a deploy/migration, create a follow-up task to harden migration/rollback procedures.

#### P1: Security / abuse (429 spikes on signed endpoints)

**Detection**

- Spike in `tg_auth_signature_requests_total{status="429"}` (overall or by `route`).
- Often correlated with increases in `tg_auth_signature_failures_total{reason,route}`.

**Impact**

- Legitimate clients may be throttled if they share NAT IPs or are retrying aggressively.
- Increased Redis load due to rate-limit counters and nonce usage patterns.

**Immediate actions**

1) Identify the blast radius:
   - Which `route` is affected:
     - `sum(rate(tg_auth_signature_requests_total{status="429"}[5m])) by (route)`
   - Top failure reasons:
     - `topk(10, sum(rate(tg_auth_signature_failures_total[5m])) by (reason, route))`
2) Differentiate bug vs abuse:
   - If 401 spikes precede 429: likely buggy client release (canonical mismatch, nonce reuse).
   - If 429 spikes without 401: could be legitimate high-volume usage or a tight retry loop.

**Mitigation (preferred order)**

1) Fix/rollback the client causing failures.
2) Apply edge protections (WAF/CDN) to reduce untrusted traffic:
   - per-IP rate limiting on the API gateway
   - bot protection / challenge for suspicious traffic
3) If you must tune server rate limits, do it deliberately and re-validate:
   - Increasing limits can hide client bugs and increase Redis load.

**Validation**

- 429 rate returns to baseline.
- `/auth/nonce` latency remains stable (watch p95).
- No sustained increase in worker tick errors (Redis pressure can cascade).

#### P0: External dependencies degraded (Webhook / Trustless Work)

This system intentionally depends on external services for certain flows. When they degrade, the correct response is to contain blast radius and keep internal state consistent.

**Detection**

- Worker tick errors rise, or dispatch failures increase:
  - `sum(rate(tg_worker_dispatch_total{result="failed"}[5m])) by (type)`
- Due retries persist for a specific handler:
  - `tg_worker_due_retries{handler="event:result_published"} > 0`
  - `tg_worker_due_retries{handler="event:task_completion_requested"} > 0`
- Logs show:
  - `webhook failed: <status>`
  - Trustless Work release errors

**Impact**

- Webhook failures:
  - `result_published` notifications may be delayed or dropped (depending on downstream durability).
  - Core marketplace state remains consistent (result is stored in DB); only notification is impacted.
- Trustless Work failures:
  - escrow releases may be delayed; tasks can remain in `COMPLETING` longer.
  - Requires careful monitoring because user-facing completion is delayed.

**Immediate actions**

1) Identify which dependency is failing:
   - If failures are mostly `result_published`: suspect downstream webhook URL or network.
   - If failures are mostly `task_completion_requested`: suspect Trustless Work connectivity/credentials.
2) Mitigate by reducing pressure and isolating failures:
   - Ensure downstream endpoints are reachable (DNS/TLS/network).
   - If webhook target is down, fix it or temporarily disable it (set `RESULT_PUBLISHED_WEBHOOK_URL` empty) and redeploy.
   - For Trustless Work, validate `TRUSTLESS_WORK_API_KEY` and service status; if service is down, communicate delay and keep retries.
3) Validate recovery:
   - Dispatch failures rate decreases.
   - Due retries return to 0 over time.
   - Worker tick success resumes without long latency spikes.

**Aftercare**

- Add explicit timeouts and circuit breakers for external calls if needed.
- Ensure webhook consumers are idempotent and durable (at-least-once delivery is expected).

#### P1: Performance degradation (slow ticks / growing retries)

**Detection**

- Tick p95 latency increases:
  - `histogram_quantile(0.95, sum(rate(tg_worker_tick_latency_ms_bucket[5m])) by (le))`
- Due retries stay > 0 and grow:
  - `max(tg_worker_due_retries) by (handler)`
- Outbox publish failures increase or success rate drops:
  - `sum(rate(tg_outbox_publish_events_total{result="failed"}[5m]))`

**Likely causes**

- Redis latency (affects auth, outbox publish, streams consumption).
- Postgres latency (repositories, outbox, idempotency bookkeeping).
- Slow external calls (webhook, Trustless Work) blocking tick completion.
- Too aggressive `publishIntervalMs` relative to actual tick duration (backpressure).

**Mitigation (safe order)**

1) Reduce pressure:
   - Increase `publishIntervalMs` temporarily to avoid piling up work.
   - Ensure only one worker instance is running (if intended).
2) Isolate slow external dependencies:
   - If only `result_published` is failing/slow, disable webhook temporarily via `RESULT_PUBLISHED_WEBHOOK_URL`.
   - For Trustless Work delays, keep retries but ensure timeouts are bounded.
3) Stabilize infra:
   - Verify Redis and Postgres resource saturation (CPU/memory/IO).
   - Fix network/DNS issues affecting external calls.

**Validation**

- Tick p95 latency returns toward baseline.
- Due retries trend down to 0.
- Dispatch failures rate decreases.

**Aftercare**

- Add explicit timeouts for external calls and consider circuit breakers.
- Re-evaluate `publishIntervalMs` after measuring real tick duration distribution.

#### P1: Deploy regression (post-release triage + safe rollback)

**Goal**
- Detect whether the current incident correlates with the most recent deploy (code/config/env) and drive a safe, incremental rollback guided by metrics — never “guess and revert” when signals exist.

**Detection (regression signals)**

- Incident started within ~10–30 minutes after release window.
- Clear step change in at least one of:
  - Auth 5xx ratio / p95 nonce latency:
    - `sum(rate(tg_auth_nonce_requests_total{status=~"5.."}[2m])) / sum(rate(tg_auth_nonce_requests_total[2m]))`
    - `histogram_quantile(0.95, sum(rate(tg_auth_nonce_latency_ms_bucket[2m])) by (le))`
  - Worker tick error ratio or p95 tick latency:
    - `sum(rate(tg_worker_tick_total{status="error"}[2m])) / sum(rate(tg_worker_tick_total[2m]))`
    - `histogram_quantile(0.95, sum(rate(tg_worker_tick_latency_ms_bucket[2m])) by (le))`
  - Outbox / stream backlog growth:
    - `max(tg_stream_pending{group=~".+"}) by (group)`
    - `tg_outbox_unprocessed`
- Same issue does NOT reproduce on the same build in staging (if you have staging).
- Version metadata or deploy logs confirm the current deploy is the candidate.

**Likely causes**

- Contract change in signed requests (client/server mismatch): nonce/payload/path/hash rules.
- Middleware/route change breaking auth or idempotency.
- DB/Redis client change (pool size, timeouts, URLs) degrading stateful paths.
- Worker change: tick logic, retry policy, or interval leading to overlap or slowdown.
- Env/config drift: flag toggles, URLs, secrets, network-specific defaults.

**Mitigation (safe order)**

1) Confirm scope first:
   - Check if the failure is isolated to one component (API vs worker vs auth vs signed routes).
   - Do NOT roll back the whole system if only one component regressed; prefer targeted rollback (client, API, worker one at a time).
2) API regression:
   - Roll back API to the previous known-good image/tag.
   - In rolling deploy, keep at least one old replica until new version is proven healthy.
   - After rollback, do NOT restart the worker blindly (it may still be healthy); let metrics decide.
3) Worker regression:
   - Roll back worker to the previous known-good image/tag.
   - Do NOT clear `event_consumptions` or `outbox_events` on rollback (that risks replay/double-spend on-chain).
   - If worker was restarted forcefully, wait for `XAUTOCLAIM` (and pending backlog) to drain via metrics.
4) Auth/client regression:
   - Roll back the client dApp (preferred) when the regression is in the signing flow.
   - NEVER weaken nonce rules as a workaround; if absolutely required (P0-only, short-lived), flip `TG_ALLOW_CLIENT_NONCE=true` temporarily and open an incident to revert.

**Validation (acceptance gates)**

- Within 2–5 minutes after rollback:
  - `GET /health` and `GET /health/detailed` are green.
  - `tg_auth_nonce_requests_total{status="200"}` returns to baseline rate; 5xx ratio drops.
  - `tg_worker_tick_total{status="success"}` resumes increasing; error ratio drops.
  - `tg_stream_pending` and `tg_outbox_unprocessed` stop growing and start trending down.
- Within 15–30 minutes:
  - `tg_worker_due_retries` drops to near-zero.
  - Dashboard anomalies (regression markers) are cleared.
- Manual smoke (only if needed):
  - `/auth/nonce` → `/auth/signed-smoke` succeeds end-to-end.

**Aftercare**

- Post-mortem:
  - Capture the deploy + rollback timeline, the triggering metric(s), and root cause hypothesis.
  - Open regression test ticket(s) to prevent the same pattern.
- Regressions by env/config drift:
  - Move secrets/URLs to versioned IaC or env per environment and add startup validations.
- Regressions by signed-request contract:
  - Add a contract test (client/server) against `/auth/nonce` + a smoke route.
- Regressions by worker interval/backpressure:
  - Automate a “deploy time sanity” check that tick duration < `publishIntervalMs`.
