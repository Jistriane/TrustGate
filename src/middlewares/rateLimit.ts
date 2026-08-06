import { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient, RedisClientType } from 'redis';
import { logger } from '../config/logger';
import { type RateLimitConfig, type RateLimitStorage } from './rateLimitConfig';

export type { RateLimitStorage } from './rateLimitConfig';
export type RateLimitBundle = {
  webhookRpm: number;
  taskCompleteRpm: number;
  bidCreateRpm: number;
  webhooks: RequestHandler;
  taskComplete: RequestHandler;
  bidCreate: RequestHandler;
  shutdown: () => Promise<void>;
  activeStorage: () => RateLimitStorage;
};

export interface LazyRateLimitHandle {
  bundle: Promise<RateLimitBundle>;
  webhooks: RequestHandler;
  taskComplete: RequestHandler;
  bidCreate: RequestHandler;
  shutdown: () => Promise<void>;
  activeStorageSync: () => RateLimitStorage | undefined;
}

export { parseRateLimitConfig, type RateLimitConfig } from './rateLimitConfig';

function readRpm(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn({ envVar: key, value: raw, fallback }, 'rate-limit: invalid value for rpm env var; using safe fallback.');
    return fallback;
  }
  return Math.trunc(n);
}

function noopHandler(): RequestHandler {
  return (_req, _res, next) => next();
}

export async function createRateLimitBundle(
  cfg: RateLimitConfig,
  envOverride: Record<string, string | undefined> = process.env,
): Promise<RateLimitBundle> {
  if (cfg.disableAll) {
    logger.warn('rate-limit: RATE_LIMIT_DISABLE_ALL=true; all rate limiters are NO-OP. NEVER do this on production unless under P0 incident and you know why.');
    return {
      webhookRpm: 0,
      taskCompleteRpm: 0,
      bidCreateRpm: 0,
      webhooks: noopHandler(),
      taskComplete: noopHandler(),
      bidCreate: noopHandler(),
      shutdown: async () => { /* noop */ },
      activeStorage: () => 'memory',
    };
  }

  const webhookRpm = readRpm(envOverride, 'RATE_LIMIT_WEBHOOK_RPM', 60);
  const taskCompleteRpm = readRpm(envOverride, 'RATE_LIMIT_TASK_COMPLETE_RPM', 30);
  const bidCreateRpm = readRpm(envOverride, 'RATE_LIMIT_BID_CREATE_RPM', 100);

  let shutdown: () => Promise<void> = async () => { /* noop */ };
  let activeStorage: RateLimitStorage = 'memory';

  const windowMs = 60_000;
  const standardHeaders = true;
  const legacyHeaders = false;

  type Builder = (scope: string, max: number, prefix: string) => RequestHandler;
  const buildMemoryLimiter: Builder = (scope, max) => rateLimit({
    windowMs, max, standardHeaders, legacyHeaders,
    statusCode: 429,
    message: { error: 'rate_limited', detail: { scope, max, windowMs: 60000 } },
  });
  let buildLimiter: Builder = buildMemoryLimiter;

  if (cfg.storage === 'redis' && cfg.redisUrl) {
    try {
      const client: RedisClientType = createClient({ url: cfg.redisUrl });
      client.on('error', (err) => logger.warn({ err: String(err).slice(0, 180) }, 'rate-limit: redis client error event; underlying store will fail-open per express-rate-limit defaults.'));
      await client.connect();
      shutdown = async () => {
        try { if (client.isOpen) await client.quit(); } catch (_) { /* noop */ }
      };
      activeStorage = 'redis';
      const sendCommand = (...args: string[]): Promise<any> => client.sendCommand(args) as Promise<any>;
      buildLimiter = (scope, max, prefix) => rateLimit({
        windowMs, max, standardHeaders, legacyHeaders,
        statusCode: 429,
        message: { error: 'rate_limited', detail: { scope, max, windowMs: 60000 } },
        store: new RedisStore({ sendCommand, prefix: `tg:rl:${prefix}:` }),
      });
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 220) }, 'rate-limit: store init failed for redis; falling back to memory store for ALL scopes this boot.');
      activeStorage = 'memory';
      buildLimiter = buildMemoryLimiter;
    }
  }

  return {
    webhookRpm,
    taskCompleteRpm,
    bidCreateRpm,
    webhooks: buildLimiter('webhooks', webhookRpm, 'wh'),
    taskComplete: buildLimiter('taskComplete', taskCompleteRpm, 'tc'),
    bidCreate: buildLimiter('bidCreate', bidCreateRpm, 'bc'),
    shutdown,
    activeStorage: () => activeStorage,
  };
}

export function createLazyRateLimitHandle(cfg: RateLimitConfig, envOverride?: Record<string, string | undefined>): LazyRateLimitHandle {
  const bundlePromise = createRateLimitBundle(cfg, envOverride);
  let resolved: RateLimitBundle | undefined;
  void bundlePromise.then((b) => { resolved = b; }).catch(() => { /* never: errors inside resolve to memory fallback */ });
  const wrap = (extract: (b: RateLimitBundle) => RequestHandler): RequestHandler => (req, res, next) => {
    bundlePromise
      .then((b) => extract(b)(req, res, next))
      .catch((err) => next(err));
  };
  return {
    bundle: bundlePromise,
    webhooks: wrap((b) => b.webhooks),
    taskComplete: wrap((b) => b.taskComplete),
    bidCreate: wrap((b) => b.bidCreate),
    shutdown: async () => {
      try { const b = await bundlePromise; await b.shutdown(); } catch (_) { /* noop */ }
    },
    activeStorageSync: () => (resolved ? resolved.activeStorage() : undefined),
  };
}
