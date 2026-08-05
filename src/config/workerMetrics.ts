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

