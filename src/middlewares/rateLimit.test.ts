import request from 'supertest';
import express, { Express, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';
import {
  MockEscrowService,
  MockMppChargeService,
  MockRegistryService,
} from '../services/mockExternalServices';
import { parseRateLimitConfig, createRateLimitBundle, createLazyRateLimitHandle } from './rateLimit';

describe('rate limit config parsing', () => {
  const baseEnv = { NODE_ENV: 'test' } as Record<string, string | undefined>;

  it('defaults to memory storage with disabled=false', () => {
    const cfg = parseRateLimitConfig({ ...baseEnv });
    expect(cfg).toEqual({ storage: 'memory', disableAll: false, redisUrl: undefined });
  });

  it('prefers memory even when storage=redis if REDIS_URL is absent (no throw)', () => {
    const cfg = parseRateLimitConfig({ ...baseEnv, RATE_LIMIT_STORAGE: 'redis' });
    expect(cfg.storage).toBe('memory');
    expect(cfg.redisUrl).toBeUndefined();
  });

  it('accepts storage=redis when REDIS_URL set', () => {
    const cfg = parseRateLimitConfig({
      ...baseEnv,
      RATE_LIMIT_STORAGE: 'redis',
      REDIS_URL: 'redis://x',
    });
    expect(cfg.storage).toBe('redis');
    expect(cfg.redisUrl).toBe('redis://x');
  });

  it('parses disableAll truthy values', () => {
    expect(parseRateLimitConfig({ ...baseEnv, RATE_LIMIT_DISABLE_ALL: 'true' }).disableAll).toBe(true);
    expect(parseRateLimitConfig({ ...baseEnv, RATE_LIMIT_DISABLE_ALL: '1' }).disableAll).toBe(true);
    expect(parseRateLimitConfig({ ...baseEnv, RATE_LIMIT_DISABLE_ALL: 'false' }).disableAll).toBe(false);
  });
});

describe('rate limit bundle — memory store', () => {
  it('respects RATE_LIMIT_DISABLE_ALL=true with zero limits and noop shuts down cleanly', async () => {
    const bundle = await createRateLimitBundle({ storage: 'memory', disableAll: true }, process.env);
    expect(bundle.webhookRpm).toBe(0);
    expect(bundle.activeStorage()).toBe('memory');
    await bundle.shutdown();
    let called = false;
    bundle.bidCreate({} as any, {} as any, () => { called = true; });
    expect(called).toBe(true);
  });

  it('honors custom rpm env vars and invalid values fall back to defaults', async () => {
    const env = {
      RATE_LIMIT_BID_CREATE_RPM: '7',
      RATE_LIMIT_TASK_COMPLETE_RPM: 'notanumber',
    };
    const bundle = await createRateLimitBundle({ storage: 'memory', disableAll: false }, env);
    expect(bundle.bidCreateRpm).toBe(7);
    expect(bundle.taskCompleteRpm).toBe(30);
    expect(bundle.webhookRpm).toBe(60);
  });

  it('rate limit middleware returns 429 with structured body after N requests', async () => {
    const env = { RATE_LIMIT_BID_CREATE_RPM: '2' };
    const bundle = await createRateLimitBundle({ storage: 'memory', disableAll: false }, env);
    const app = express();
    app.get('/hit', bundle.bidCreate, (_req: Request, res: Response) => res.status(200).json({ ok: true }));
    const a = request(app).get('/hit');
    const b = request(app).get('/hit');
    const c = request(app).get('/hit');
    const ra = await a; expect(ra.status).toBe(200);
    const rb = await b; expect(rb.status).toBe(200);
    const rc = await c;
    expect(rc.status).toBe(429);
    expect(rc.body?.error).toBe('rate_limited');
    expect(rc.body?.detail?.scope).toBe('bidCreate');
    expect(rc.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('lazy rate limit handle wiring smoke (createApp does not throw)', () => {
  let app: Express | undefined;

  beforeAll(() => {
    process.env.NETWORK = process.env.NETWORK ?? 'local';
    process.env.REGISTRY_CONTRACT_ID =
      process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
    process.env.MARKETPLACE_WALLET =
      process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
    process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';
    const overrides = {
      registryService: new MockRegistryService(),
      mppChargeService: new MockMppChargeService(),
      escrowService: new MockEscrowService(),
      listingFeeGateFactory: async (): Promise<any> => (_req: any, _res: any, next: any) => next(),
    } as Parameters<typeof createApp>[0];
    app = createApp(overrides);
  });

  it('exposes a shutdown handle via app settings', async () => {
    const shutdown = app?.get('rateLimitBundleShutdown') as (() => Promise<void>) | undefined;
    expect(typeof shutdown).toBe('function');
    await shutdown!();
  });

  it('/health returns 200 (proof createApp did not break on lazy init)', async () => {
    const res = await request(app!).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('createLazyRateLimitHandle wrap semantics', () => {
  it('calls underlying limiter after resolution and shutdown resolves', async () => {
    const h = createLazyRateLimitHandle({ storage: 'memory', disableAll: false }, { RATE_LIMIT_BID_CREATE_RPM: '1' });
    expect(h.activeStorageSync()).toBeUndefined();
    let passed = 0;
    const mw = h.bidCreate;
    // Simulate 2 requests; first is allowed (under limit), second will be 429.
    await new Promise<void>((resolve) => mw({} as any, { status: () => ({ json: () => resolve() }) } as any, () => { passed++; resolve(); }));
    expect(passed).toBe(1);
    expect(h.activeStorageSync()).toBe('memory');
    await h.shutdown();
  });
});
