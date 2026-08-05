import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from './metrics';

export const tgAuthNonceRequestsTotal = new Counter({
  name: 'tg_auth_nonce_requests_total',
  help: 'Total number of /auth/nonce requests by status code',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const tgAuthNonceLatencyMs = new Histogram({
  name: 'tg_auth_nonce_latency_ms',
  help: 'Latency of /auth/nonce in milliseconds',
  labelNames: ['status'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const tgAuthSignatureRequestsTotal = new Counter({
  name: 'tg_auth_signature_requests_total',
  help: 'Total number of signed-request auth checks by status code',
  labelNames: ['status', 'route'] as const,
  registers: [metricsRegistry],
});

export const tgAuthSignatureLatencyMs = new Histogram({
  name: 'tg_auth_signature_latency_ms',
  help: 'Latency of signed-request auth checks in milliseconds',
  labelNames: ['status', 'route'] as const,
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [metricsRegistry],
});

export const tgAuthSignatureFailuresTotal = new Counter({
  name: 'tg_auth_signature_failures_total',
  help: 'Total number of signed-request auth failures by reason',
  labelNames: ['reason', 'route'] as const,
  registers: [metricsRegistry],
});

