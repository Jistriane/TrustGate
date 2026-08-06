# ADR 0001: Idempotent Outbox + Worker (Redis Streams) and asynchronous completion with Trustless Work

## Status
- Accepted
- Date: 2026-08-04

## Context
- TrustGate executes external actions (e.g.: Trustless Work escrow, webhooks, payments) that cannot be coupled to the synchronous request/response cycle without increasing the risk of timeouts, duplicate retries, and inconsistencies.
- We need to tolerate transient failures (network, external dependencies) and, at the same time, guarantee that business effects are executed in a controlled manner.
- The system already uses Postgres for persistence and Redis for queue/streams.

## Decision
- Adopt the **Outbox** pattern in Postgres:
  - The API writes a record to `outbox_events` as part of the main write flow.
  - A publisher publishes these events to **Redis Streams** and marks `processed_at` in Postgres.
- Consume Redis Streams via **consumer group** and process events in a **Worker** separate from the HTTP server.
- Delivery guarantee: **at-least-once**, with **handler-level idempotency** persisted in Postgres:
  - Register consumption in `event_consumptions` with unique key `(handler_name, event_id)`.
  - On reprocessings/duplications, the handler returns without re-executing effects.
- Move sensitive external effects to the worker:
  - In particular, the "`POST /tasks/:id/complete` → escrow release (Trustless Work)" flow becomes asynchronous when Outbox is enabled:
    - API changes the task to `COMPLETING` and emits `task_completion_requested`.
    - Worker executes `releaseMilestone`, marks task `COMPLETED` and emits `task_completed`.
  - Without Outbox (local/in-memory mode), keep synchronous fallback to ease development and testing.

## Consequences
- Pros
  - Reduces risk of timeouts and duplications caused by client retries.
  - Allows retries and backoff without blocking requests.
  - Keeps Postgres as the source of truth and auditable trail of events/consumptions.
  - Enables **backlog observability** (XLEN / XPENDING summary / XPENDING per consumer) directly via Prometheus metrics exposed at `/metrics` — diagnosing stuck consumers or backpressure does not require `redis-cli` access.
  - `XAUTOCLAIM` + per-consumer metrics allow automatic detection and recovery from dead workers without manual intervention in the vast majority of cases.
- Cons
  - Introduces eventual consistency: some effects now occur after the HTTP response (e.g.: `POST /tasks/:id/complete` returns 202, escrow release via Trustless Work is asynchronous).
  - Increases operational surface (worker + redis streams). Requires **observability baseline** (signed smoke + mandatory metrics + Prometheus rules) before each deploy per [docs/observability.md](file:///home/jistriane/TrustGate/TrustGate/docs/observability.md).
  - Demands discipline for idempotent handlers and versionable event contracts.
  - The `tg_stream_pending_consumer{stream,group,consumer}` metric has one extra label; **cardinality must be kept low** (fixed number of consumers, typically 1–16), and the worker explicitly zeroes out consumers that disappear after sampling to avoid timeseries explosion.

## Additional operational trade-offs (2026-08-05 update)

For each worker tick, a **backlog sampling** path runs every ~5 seconds (decoupled from the tick hot-path to not add latency in event processing):

| Sampling | Where it reads | Exposed metric | Why |
|-----------|---------|-----------------|---------|
| Stream size | Redis `XLEN` | `tg_stream_length{stream,group}` | Detects producer faster than consumers. |
| PEL summary | Redis `XPENDING` summary count | `tg_stream_pending{stream,group}` | Detects entries delivered but never `XACK`ed (slow handler / error). |
| PEL per consumer | Redis `XPENDING` per consumer | `tg_stream_pending_consumer{stream,group,consumer}` | Detects 1 specific worker stuck / partitioned before `XAUTOCLAIM` collects. |
| Outbox unprocessed | Postgres `processed_at IS NULL` | `tg_outbox_unprocessed` | Detects stopped publisher (Postgres → Stream). |
| Outbox failed | Postgres `attempts > 0 AND processed_at IS NULL` | `tg_outbox_failed` | Detects publisher with persistent failures (emergency). |

Sampling interval (default 5 s, adjustable via env var `OUTBOX_BACKLOG_SAMPLE_MS` in src/server.ts with minimum 1000 ms and floor `Math.trunc`) was chosen to not overload Redis/Postgres on 2 s ticks; for workloads with >1k events/s, it is safe to raise the interval to 10–15 s via env var adjustment (it is no longer hardcoded as in the initial revision of this ADR; WorkerServiceOptions accepts `backlogSampleIntervalMs` as an optional field, default 5000 ms).

## Alternatives considered
- Execute external integrations in request/response (synchronous)
  - Rejected: high risk of timeout, network failures, and duplication on retries.
- Redis-only (without Postgres outbox)
  - Rejected: higher risk of loss/indefinition of "source of truth" and lower auditability.
- Strict exactly-once
  - Rejected: higher cost/complexity than the current value; at-least-once with idempotency meets the objective with lower risk.
