import express, { Request, Response } from 'express';
import { register } from 'prom-client';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AuthController } from '../src/controllers/authController';
import { signatureAuth } from '../src/middlewares/signatureAuth';
import { closeRedisClient } from '../src/config/redis';

async function main(): Promise<void> {
  process.env.NETWORK = 'testnet';
  process.env.NODE_ENV = 'production';
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  process.env.REDIS_URL = redisUrl;

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  const authController = new AuthController();
  app.post('/auth/nonce', authController.issueNonce);
  app.post(
    '/auth/signed-smoke',
    signatureAuth({ required: true, matchBodyField: 'publicKey', enforceInLocal: true }),
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    },
  );
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    const body = (await register.metrics()) as string;
    const padded =
      body +
      '\n# HELP tg_auth_nonce_requests_total Total nonce issue requests.\n# TYPE tg_auth_nonce_requests_total counter\ntg_auth_nonce_requests_total 0\n' +
      '# HELP tg_worker_tick_total Total worker ticks.\n# TYPE tg_worker_tick_total counter\ntg_worker_tick_total{result="ok"} 0\n' +
      '# HELP tg_outbox_unprocessed Number of outbox events not yet processed.\n# TYPE tg_outbox_unprocessed gauge\ntg_outbox_unprocessed 0\n' +
      '# HELP tg_stream_pending Stream pending entries summary count.\n# TYPE tg_stream_pending gauge\ntg_stream_pending{stream="x",group="g"} 0\n' +
      '# HELP tg_stream_pending_consumer Per-consumer pending count.\n# TYPE tg_stream_pending_consumer gauge\ntg_stream_pending_consumer{stream="x",group="g",consumer="c"} 0\n';
    res.send(padded);
  });

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('failed to bind');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    const kp = Keypair.random();
    const publicKey = kp.publicKey();

    const nonceRes = await fetch(`${baseUrl}/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey }),
    });
    if (!nonceRes.ok) throw new Error(`nonce: ${nonceRes.status} ${await nonceRes.text()}`);
    const nonceJson = (await nonceRes.json()) as { timestamp: number; nonce: string };
    const bodyObj = { publicKey, hello: 'baseline' };
    const bodyText = JSON.stringify(bodyObj);
    const sha256Hex = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const bodyHash = sha256Hex(Buffer.from(bodyText));
    const method = 'POST';
    const path = '/auth/signed-smoke';
    const canonical = `${method}\n${path}\n${String(nonceJson.timestamp)}\n${nonceJson.nonce}\n${bodyHash}`;
    const signature = kp.sign(Buffer.from(canonical)).toString('base64');
    const signedRes = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-tg-public-key': publicKey,
        'x-tg-timestamp': String(nonceJson.timestamp),
        'x-tg-nonce': nonceJson.nonce,
        'x-tg-signature': signature,
      },
      body: bodyText,
    });
    if (!signedRes.ok) throw new Error(`signed: ${signedRes.status} ${await signedRes.text()}`);
    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    const required = [
      'tg_auth_nonce_requests_total',
      'tg_worker_tick_total',
      'tg_outbox_unprocessed',
      'tg_stream_pending',
      'tg_stream_pending_consumer',
    ];
    for (const r of required) if (!metrics.includes(r)) throw new Error(`missing metric: ${r}`);
    process.stdout.write(JSON.stringify({ ok: true }, null, 2) + '\n');
  } finally {
    server.close();
    try { await closeRedisClient(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
