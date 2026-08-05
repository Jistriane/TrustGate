import express, { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AuthController } from '../src/controllers/authController';
import { signatureAuth } from '../src/middlewares/signatureAuth';
import { closeRedisClient } from '../src/config/redis';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function main(): Promise<void> {
  const network = process.env.NETWORK;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required');
  }
  if (!network || network === 'local') {
    throw new Error('NETWORK must be set to testnet/pubnet (not local)');
  }
  if (process.env.NODE_ENV === 'test') {
    throw new Error('NODE_ENV must not be test (signatureAuth bypasses in test)');
  }

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
    '/__smoke/signed',
    signatureAuth({ required: true, matchBodyField: 'publicKey' }),
    (req: Request, res: Response) => {
      res.status(200).json({ ok: true, authPublicKey: (req as unknown as { authPublicKey?: string }).authPublicKey });
    },
  );

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const addressInfo = server.address();
  if (!addressInfo || typeof addressInfo === 'string') {
    server.close();
    throw new Error('failed to bind server');
  }
  const baseUrl = `http://127.0.0.1:${addressInfo.port}`;

  const kp = Keypair.random();
  const publicKey = kp.publicKey();

  const nonceRes = await fetch(`${baseUrl}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (!nonceRes.ok) {
    server.close();
    throw new Error(`nonce failed: ${nonceRes.status} ${await nonceRes.text()}`);
  }
  const nonceJson = (await nonceRes.json()) as { timestamp: number; nonce: string };

  const bodyObj = { publicKey, hello: 'world' };
  const bodyText = JSON.stringify(bodyObj);
  const bodyHash = sha256Hex(Buffer.from(bodyText));
  const path = '/__smoke/signed';
  const method = 'POST';
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
  const signedText = await signedRes.text();
  server.close();
  await closeRedisClient();

  if (!signedRes.ok) {
    throw new Error(`signed request failed: ${signedRes.status} ${signedText}`);
  }

  const signedJson = JSON.parse(signedText) as { ok: boolean; authPublicKey?: string };
  if (!signedJson.ok || signedJson.authPublicKey !== publicKey) {
    throw new Error(`unexpected response: ${signedText}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, publicKey }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err instanceof Error ? err.stack ?? err.message : err)}\n`);
  process.exit(1);
});
