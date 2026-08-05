import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import { getRedisClient } from '../config/redis';
import { tgAuthNonceLatencyMs, tgAuthNonceRequestsTotal } from '../config/authMetrics';

function getClientIp(req: Request): string {
  const ip = req.ip || (req.connection as unknown as { remoteAddress?: string }).remoteAddress;
  return String(ip ?? '');
}

async function incrWithTtl(redis: Awaited<ReturnType<typeof getRedisClient>>, key: string, ttlSeconds: number) {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

export class AuthController {
  issueNonce = async (req: Request, res: Response): Promise<void> => {
    const start = process.hrtime.bigint();
    const record = (status: number): void => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      tgAuthNonceRequestsTotal.inc({ status: String(status) });
      tgAuthNonceLatencyMs.observe({ status: String(status) }, ms);
    };

    const publicKey = String((req.body ?? {}).publicKey ?? '');
    if (!publicKey) {
      record(400);
      res.status(400).json({ error: 'publicKey is required' });
      return;
    }

    try {
      Keypair.fromPublicKey(publicKey);
    } catch {
      record(400);
      res.status(400).json({ error: 'invalid public key' });
      return;
    }

    const redis = await getRedisClient();
    const ip = getClientIp(req);
    const ipKey = `tg:authnonce:ip:${ip}`;
    const ipCount = await incrWithTtl(redis, ipKey, 60);
    if (ipCount > 60) {
      record(429);
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const ttlSeconds = 600;
    const timestamp = Date.now();
    const nonce = randomUUID();
    const nonceKey = `tg:nonce2:${publicKey}:${nonce}`;
    const ok = await redis.set(nonceKey, String(timestamp), { NX: true, EX: ttlSeconds });
    if (ok !== 'OK') {
      record(503);
      res.status(503).json({ error: 'nonce store unavailable' });
      return;
    }

    record(200);
    res.status(200).json({
      version: 1,
      publicKey,
      timestamp,
      nonce,
      ttlSeconds,
    });
  };
}
