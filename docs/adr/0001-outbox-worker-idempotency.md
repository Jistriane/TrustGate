# ADR 0001: Outbox + idempotent Worker (Redis Streams) and asynchronous completion with Trustless Work

## Status
- Accepted
- Date: 2026-08-04

## Context
- TrustGate performs external actions (e.g. Trustless Work escrow, webhooks, payments) that cannot stay coupled to the synchronous request/response cycle without increasing the risk of timeouts, duplicate retries and inconsistencies.
- We need to tolerate transient failures (network, external dependencies) while still guaranteeing that business effects are executed in a controlled way.
- The system already uses Postgres for persistence and Redis for queueing/streams.

## Decision
- Adopt the **Outbox** pattern in Postgres:
  - The API writes a record into `outbox_events` as part of the main write flow.
  - A publisher publishes those events to **Redis Streams** and marks `processed_at` in Postgres.
- Consume Redis Streams via a **consumer group** and process events in a **Worker** separate from the HTTP server.
- Delivery guarantee: **at-least-once**, with **per-handler idempotency** persisted in Postgres:
  - Record consumption in `event_consumptions` with the unique key `(handler_name, event_id)`.
  - On reprocessing/duplication, the handler returns without re-executing effects.
- Move sensitive external effects to the worker:
  - In particular, the "`POST /tasks/:id/complete` → escrow release (Trustless Work)" flow becomes asynchronous when Outbox is enabled:
    - The API moves the task to `COMPLETING` and emits `task_completion_requested`.
    - The Worker runs `releaseMilestone`, marks the task `COMPLETED` and emits `task_completed`.
  - Without Outbox (local/in-memory mode), keep the synchronous fallback to make dev and tests easier.

## Consequences
- Pros
  - Reduces the risk of timeouts and duplication caused by client retries.
  - Allows retries and backoff without blocking requests.
  - Keeps Postgres as the source of truth and an auditable trail of events/consumptions.
  - Enables **backlog observability** (XLEN / XPENDING summary / XPENDING per consumer) directly through Prometheus metrics exposed at `/metrics` — diagnosing a stuck consumer or backpressure does not require `redis-cli` access.
  - `XAUTOCLAIM` + per-consumer metrics allow detecting and automatically recovering from dead workers without manual intervention in the vast majority of cases.
- Cons
  - Introduces eventual consistency: some effects now happen after the HTTP response (e.g. `POST /tasks/:id/complete` returns 202, the escrow release via Trustless Work is asynchronous).
  - Increases the operational surface (worker + redis streams). Requires an **observability baseline** (signed smoke + mandatory metrics + Prometheus rules) before every deploy, as described in [docs/observability.md](../observability.md).
  - Demands discipline around idempotent handlers and versionable event contracts.
  - The `tg_stream_pending_consumer{stream,group,consumer}` metric carries one extra label; **cardinality must be kept low** (a fixed number of consumers, typically 1–16), and the worker explicitly zeroes consumers that disappear after sampling to avoid a timeseries explosion.

## Additional operational trade-offs (2026-08-05 update)

For each worker tick, a **backlog sampling** path runs every ~5 seconds (decoupled from the tick hot path so it does not add latency to event processing):

| Sampling | Where it reads | Exposed metric | Why |
|----------|----------------|----------------|-----|
| Stream size | Redis `XLEN` | `tg_stream_length{stream,group}` | Detects a producer faster than the consumers. |
| PEL summary | Redis `XPENDING` summary count | `tg_stream_pending{stream,group}` | Detects entries delivered but never `XACK`ed (slow handler / error). |
| PEL per consumer | Redis `XPENDING` per consumer | `tg_stream_pending_consumer{stream,group,consumer}` | Detects one specific worker stuck / partitioned before `XAUTOCLAIM` reclaims it. |
| Outbox unprocessed | Postgres `processed_at IS NULL` | `tg_outbox_unprocessed` | Detects a stalled publisher (Postgres → Stream). |
| Outbox failed | Postgres `attempts > 0 AND processed_at IS NULL` | `tg_outbox_failed` | Detects a publisher with persistent failures (emergency). |

The sampling interval (default 5 s, tunable via the `OUTBOX_BACKLOG_SAMPLE_MS` env var in src/server.ts, with a 1000 ms minimum and a `Math.trunc` floor) was chosen so as not to overload Redis/Postgres on 2 s ticks; for workloads above 1k events/s it is safe to raise the interval to 10–15 s by adjusting the env var (it is no longer hardcoded as in the initial revision of this ADR; WorkerServiceOptions accepts `backlogSampleIntervalMs` as an optional field, default 5000 ms).

## Alternatives considered
- Running external integrations inside request/response (synchronous)
  - Rejected: high risk of timeouts, network failures, and duplication on retries.
- Redis-only (no outbox in Postgres)
  - Rejected: higher risk of losing / blurring the "source of truth" and lower auditability.
- Strict exactly-once
  - Rejected: cost/complexity higher than the current value; at-least-once with idempotency meets the goal at lower risk.
