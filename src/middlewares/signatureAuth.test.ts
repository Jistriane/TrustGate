import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

class FakeRedis {
  store = new Map<string, string>();
  counters = new Map<string, number>();

  async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
    if (opts?.NX && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async sendCommand(cmd: string[]) {
    if (cmd[0] === 'GETDEL') {
      const key = cmd[1];
      const value = this.store.get(key);
      if (value === undefined) return null;
      this.store.delete(key);
      return value;
    }
    throw new Error(`unsupported command: ${cmd[0]}`);
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

import { signatureAuth } from './signatureAuth';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('signatureAuth', () => {
  beforeEach(() => {
    fakeRedis.store.clear();
    fakeRedis.counters.clear();
  });

  it('accepts a valid signature and consumes a server-issued nonce', async () => {
    const prevNetwork = process.env.NETWORK;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllow = process.env.TG_ALLOW_CLIENT_NONCE;
    process.env.NETWORK = 'testnet';
    process.env.NODE_ENV = 'development';
    process.env.TG_ALLOW_CLIENT_NONCE = 'false';

    const app = express();
    app.set('trust proxy', true);
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.post('/protected', signatureAuth(), (_req, res) => res.status(200).json({ ok: true }));

    const kp = Keypair.random();
    const timestamp = Date.now();
    const nonce = 'a5a88b0e-5fc4-4d04-9d83-7a7aa8e4b6cb';
    fakeRedis.store.set(`tg:nonce2:${kp.publicKey()}:${nonce}`, String(timestamp));

    const body = { hello: 'world' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const payload = `POST\n/protected\n${timestamp}\n${nonce}\n${sha256Hex(rawBody)}`;
    const signature = kp.sign(Buffer.from(payload)).toString('base64');

    const response = await request(app)
      .post('/protected')
      .set('X-Forwarded-For', '203.0.113.11')
      .set('x-tg-public-key', kp.publicKey())
      .set('x-tg-timestamp', String(timestamp))
      .set('x-tg-nonce', nonce)
      .set('x-tg-signature', signature)
      .send(body);

    expect(response.status).toBe(200);
    expect(fakeRedis.store.has(`tg:nonce2:${kp.publicKey()}:${nonce}`)).toBe(false);

    process.env.NETWORK = prevNetwork;
    process.env.NODE_ENV = prevNodeEnv;
    process.env.TG_ALLOW_CLIENT_NONCE = prevAllow;
  });

  it('can be enforced on local network when explicitly enabled', async () => {
    const prevNetwork = process.env.NETWORK;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllow = process.env.TG_ALLOW_CLIENT_NONCE;
    process.env.NETWORK = 'local';
    process.env.NODE_ENV = 'development';
    process.env.TG_ALLOW_CLIENT_NONCE = 'false';

    const app = express();
    app.set('trust proxy', true);
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.post('/protected', signatureAuth({ enforceInLocal: true }), (_req, res) => res.status(200).json({ ok: true }));

    const kp = Keypair.random();
    const timestamp = Date.now();
    const nonce = 'b4f43771-41cf-44a4-8c62-5c400c67e8c9';
    fakeRedis.store.set(`tg:nonce2:${kp.publicKey()}:${nonce}`, String(timestamp));

    const body = { hello: 'world' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const payload = `POST\n/protected\n${timestamp}\n${nonce}\n${sha256Hex(rawBody)}`;
    const signature = kp.sign(Buffer.from(payload)).toString('base64');

    const response = await request(app)
      .post('/protected')
      .set('X-Forwarded-For', '203.0.113.14')
      .set('x-tg-public-key', kp.publicKey())
      .set('x-tg-timestamp', String(timestamp))
      .set('x-tg-nonce', nonce)
      .set('x-tg-signature', signature)
      .send(body);

    expect(response.status).toBe(200);
    expect(fakeRedis.store.has(`tg:nonce2:${kp.publicKey()}:${nonce}`)).toBe(false);

    process.env.NETWORK = prevNetwork;
    process.env.NODE_ENV = prevNodeEnv;
    process.env.TG_ALLOW_CLIENT_NONCE = prevAllow;
  });

  it('rejects replay when nonce is already consumed', async () => {
    const prevNetwork = process.env.NETWORK;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllow = process.env.TG_ALLOW_CLIENT_NONCE;
    process.env.NETWORK = 'testnet';
    process.env.NODE_ENV = 'development';
    process.env.TG_ALLOW_CLIENT_NONCE = 'false';

    const app = express();
    app.set('trust proxy', true);
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.post('/protected', signatureAuth(), (_req, res) => res.status(200).json({ ok: true }));

    const kp = Keypair.random();
    const timestamp = Date.now();
    const nonce = '3e9d5b0c-7d32-4cf9-a2e0-40450b8b6a75';
    fakeRedis.store.set(`tg:nonce2:${kp.publicKey()}:${nonce}`, String(timestamp));

    const body = { hello: 'world' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const payload = `POST\n/protected\n${timestamp}\n${nonce}\n${sha256Hex(rawBody)}`;
    const signature = kp.sign(Buffer.from(payload)).toString('base64');

    await request(app)
      .post('/protected')
      .set('X-Forwarded-For', '203.0.113.12')
      .set('x-tg-public-key', kp.publicKey())
      .set('x-tg-timestamp', String(timestamp))
      .set('x-tg-nonce', nonce)
      .set('x-tg-signature', signature)
      .send(body);

    const response2 = await request(app)
      .post('/protected')
      .set('X-Forwarded-For', '203.0.113.12')
      .set('x-tg-public-key', kp.publicKey())
      .set('x-tg-timestamp', String(timestamp))
      .set('x-tg-nonce', nonce)
      .set('x-tg-signature', signature)
      .send(body);

    expect(response2.status).toBe(401);
    expect(response2.body.error).toBe('invalid nonce');

    process.env.NETWORK = prevNetwork;
    process.env.NODE_ENV = prevNodeEnv;
    process.env.TG_ALLOW_CLIENT_NONCE = prevAllow;
  });

  it('rate limits repeated failures', async () => {
    const prevNetwork = process.env.NETWORK;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllow = process.env.TG_ALLOW_CLIENT_NONCE;
    process.env.NETWORK = 'testnet';
    process.env.NODE_ENV = 'development';
    process.env.TG_ALLOW_CLIENT_NONCE = 'false';

    const app = express();
    app.set('trust proxy', true);
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = buf;
        },
      }),
    );
    app.post('/protected', signatureAuth(), (_req, res) => res.status(200).json({ ok: true }));

    const kp = Keypair.random();
    const timestamp = Date.now();
    const nonce = 'c9c0e810-d73b-4f0f-a2b2-9f5b0a0fcb1e';

    const body = { hello: 'world' };
    const rawBody = Buffer.from(JSON.stringify(body));
    const payload = `POST\n/protected\n${timestamp}\n${nonce}\n${sha256Hex(rawBody)}`;
    const signature = kp.sign(Buffer.from(payload)).toString('base64');

    let lastStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await request(app)
        .post('/protected')
        .set('X-Forwarded-For', '203.0.113.13')
        .set('x-tg-public-key', kp.publicKey())
        .set('x-tg-timestamp', String(timestamp))
        .set('x-tg-nonce', nonce)
        .set('x-tg-signature', signature)
        .send(body);
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);

    process.env.NETWORK = prevNetwork;
    process.env.NODE_ENV = prevNodeEnv;
    process.env.TG_ALLOW_CLIENT_NONCE = prevAllow;
  });
});
