import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AuthController } from './authController';

class FakeRedis {
  store = new Map<string, string>();
  counters = new Map<string, number>();

  async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
    if (opts?.NX && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string) {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(_key: string, _ttlSeconds: number) {
    return 1;
  }
}

const fakeRedis = new FakeRedis();

jest.mock('../config/redis', () => ({
  getRedisClient: async () => fakeRedis,
}));

describe('POST /auth/nonce', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    fakeRedis.counters.clear();
  });

  it('issues a nonce stored in Redis', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    const controller = new AuthController();
    app.post('/auth/nonce', controller.issueNonce);

    const kp = Keypair.random();
    const response = await request(app)
      .post('/auth/nonce')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ publicKey: kp.publicKey() });

    expect(response.status).toBe(200);
    expect(response.body.publicKey).toBe(kp.publicKey());
    expect(typeof response.body.timestamp).toBe('number');
    expect(typeof response.body.nonce).toBe('string');
    expect(response.body.ttlSeconds).toBe(600);

    const nonceKey = `tg:nonce2:${kp.publicKey()}:${response.body.nonce}`;
    expect(fakeRedis.store.has(nonceKey)).toBe(true);
  });
});
