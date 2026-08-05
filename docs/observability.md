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

- Alert rules live in `prom/alerts/trustgate-alerts.yml`.
- How to load:
  - Add it to your Prometheus config under `rule_files`, for example:

```yml
rule_files:
  - /etc/prometheus/alerts/trustgate-alerts.yml
```

Then mount/copy `prom/alerts/trustgate-alerts.yml` into that path in your Prometheus deployment.

### Local stack (Docker Compose)

You can run Prometheus + Grafana locally (and have Prometheus scrape the app) by starting the main stack and the observability stack together:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up --build -d
```

- App metrics: `http://localhost:3000/metrics`
- Prometheus UI: `http://localhost:9090`
- Grafana UI: `http://localhost:3001`

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
- `tg_worker_autoclaim_entries_total`
- `tg_worker_poll_entries_total`
- `tg_worker_dispatch_total{type,result}`
- `tg_worker_due_retries{handler}`

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
    - Consider increasing `publishIntervalMs` to reduce pressure, or adding timeouts/circuit breakers for external calls.

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
