import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from './metrics';

export const tgWorkerTickTotal = new Counter({
  name: 'tg_worker_tick_total',
  help: 'Total number of worker ticks by status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const tgWorkerTickLatencyMs = new Histogram({
  name: 'tg_worker_tick_latency_ms',
  help: 'Worker tick duration in milliseconds',
  labelNames: ['status'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

export const tgOutboxPublishEventsTotal = new Counter({
  name: 'tg_outbox_publish_events_total',
  help: 'Total outbox events published to Redis Streams by result',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

export const tgOutboxUnprocessed = new Gauge({
  name: 'tg_outbox_unprocessed',
  help: 'Number of outbox events that are not processed yet',
  registers: [metricsRegistry],
});

export const tgOutboxFailed = new Gauge({
  name: 'tg_outbox_failed',
  help: 'Number of outbox events that have failures recorded (attempts > 0)',
  registers: [metricsRegistry],
});

export const tgStreamLength = new Gauge({
  name: 'tg_stream_length',
  help: 'Redis Stream length (XLEN) by stream and group',
  labelNames: ['stream', 'group'] as const,
  registers: [metricsRegistry],
});

export const tgStreamPending = new Gauge({
  name: 'tg_stream_pending',
  help: 'Redis Stream pending messages (XPENDING summary count) by stream and group',
  labelNames: ['stream', 'group'] as const,
  registers: [metricsRegistry],
});

export const tgStreamPendingConsumer = new Gauge({
  name: 'tg_stream_pending_consumer',
  help: 'Redis Stream pending messages (XPENDING by-consumer summary) by stream, group, and consumer',
  labelNames: ['stream', 'group', 'consumer'] as const,
  registers: [metricsRegistry],
});

export const tgWorkerAutoClaimEntriesTotal = new Counter({
  name: 'tg_worker_autoclaim_entries_total',
  help: 'Total number of stream entries processed via XAUTOCLAIM',
  registers: [metricsRegistry],
});

export const tgWorkerPollEntriesTotal = new Counter({
  name: 'tg_worker_poll_entries_total',
  help: 'Total number of stream entries processed via XREADGROUP',
  registers: [metricsRegistry],
});

export const tgWorkerDispatchTotal = new Counter({
  name: 'tg_worker_dispatch_total',
  help: 'Total number of event dispatch attempts by type and result',
  labelNames: ['type', 'result'] as const,
  registers: [metricsRegistry],
});

export const tgWorkerDueRetries = new Gauge({
  name: 'tg_worker_due_retries',
  help: 'Number of due retry records by handler_name at tick time',
  labelNames: ['handler'] as const,
  registers: [metricsRegistry],
});

export const tgWebhookAttemptsTotal = new Counter({
  name: 'tg_webhook_attempts_total',
  help: 'Total outbound webhook HTTP attempts by event type and result status class. status_class is one of: 2xx/3xx/4xx/5xx/network/timeout.',
  labelNames: ['event_type', 'status_class'] as const,
  registers: [metricsRegistry],
});

export const tgWebhookRetriesTotal = new Counter({
  name: 'tg_webhook_retries_total',
  help: 'Total retries triggered by the exponential-backoff wrapper inside a single webhook call. reason is one of: 5xx/429/408/network/timeout/retry_after.',
  labelNames: ['event_type', 'reason'] as const,
  registers: [metricsRegistry],
});

export const tgWebhookFailedPermanentTotal = new Counter({
  name: 'tg_webhook_failed_permanent_total',
  help: 'Total webhook calls that permanently failed (inner postJson retry exhaustion OR worker-level WORKER_MAX_ATTEMPTS reached). Non-retryable (4xx) and retryable (5xx/network) failures both count here after the outermost retry loop gives up.',
  labelNames: ['event_type', 'last_status_class'] as const,
  registers: [metricsRegistry],
});

export const tgClaimTimeoutAttemptsTotal = new Counter({
  name: 'tg_claim_timeout_attempts_total',
  help: 'Total number of claim_timeout RPC attempts triggered by TimeoutService.runClaimTimeoutPass worker cron, by result category: success / claim_too_early (on-chain ClaimTooEarly ledger < 14d) / error (any other on-chain or network error).',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

export const tgEscrowContractInstanceTtlDays = new Gauge({
  name: 'tg_escrow_contract_instance_ttl_days',
  help: 'Soroban instance storage TTL calculated in days (ADR 0004 §2). Updated every worker.cron (6h). When < 60 days → warning alert; < 30 days → critical P0: run soroban contract extend urgently.',
  registers: [metricsRegistry],
});

/**
 * P2-8 V16.
 * Histogram/Counter for TTL fetch QUALITY.
 *   method = fetch:json        → successful JSON parse of soroban contract fetch --json.
 *   method = fetch:empty       → empty stdout (RPC returned nothing).
 *   method = status:fallback:518_400 → soroban network status ledger parse + 518400 ledgers ~30d fallback estimate.
 *   method = unavailable       → 2 methods failed; we use defaultFallbackDays via logger warn.
 * SRE can alert in PromQL: rate(tg_escrow_ttl_fetch_total{method!="fetch:json"}[24h]) > 0
 *   to know if JSON parsing has started failing continuously.
 */
export const tgEscrowTtlFetchTotal = new Counter({
  name: 'tg_escrow_ttl_fetch_total',
  help: 'Number of TTL fetch method calls categorized by method. Useful for SRE to detect gradual degradation (fallback 518_400 being used instead of real JSON fetch).',
  labelNames: ['method'] as const,
  registers: [metricsRegistry],
});
