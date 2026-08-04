import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from './app';

describe('GET /health', () => {
  beforeAll(() => {
    process.env.REGISTRY_CONTRACT_ID =
      process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
    process.env.MARKETPLACE_WALLET =
      process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
    process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';
  });

  it('returns 200 and status ok', async () => {
    const app = createApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /health/detailed', () => {
  it('reports per-dependency status', async () => {
    const app = createApp();
    const response = await request(app).get('/health/detailed');
    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty('dependencies.stellarRpc.status');
    expect(response.body).toHaveProperty('dependencies.redis.status');
  }, 15000);
});

describe('GET /metrics', () => {
  it('returns Prometheus-formatted Node.js process metrics', async () => {
    const app = createApp();
    const response = await request(app).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.text).toContain('process_cpu_user_seconds_total');
    expect(response.text).toContain('nodejs_heap_size_total_bytes');
  });
});

describe('GET /api-docs', () => {
  it('serves the Swagger UI page', async () => {
    const app = createApp();
    const response = await request(app).get('/api-docs/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('swagger-ui');
  });
});

describe('request logging correlation', () => {
  it('echoes a caller-supplied X-Request-Id and generates one when absent', async () => {
    process.env.NODE_ENV = 'production';
    const app = createApp();

    const withId = await request(app).get('/health').set('X-Request-Id', 'test-correlation-id');
    expect(withId.headers['x-request-id']).toBe('test-correlation-id');

    const withoutId = await request(app).get('/health');
    expect(withoutId.headers['x-request-id']).toBeTruthy();

    process.env.NODE_ENV = 'test';
  });
});
