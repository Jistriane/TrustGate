import { NextFunction, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { getRedisClient } from '../config/redis';
import { logger } from '../config/logger';
import {
  tgAuthSignatureFailuresTotal,
  tgAuthSignatureLatencyMs,
  tgAuthSignatureRequestsTotal,
} from '../config/authMetrics';

export interface SignatureAuthOptions {
  required?: boolean;
  matchBodyField?: string;
  nonceTtlSeconds?: number;
  enforceInLocal?: boolean;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function getRequestPath(req: Request): string {
  const original = req.originalUrl ?? req.url;
  return original.split('?')[0] ?? '';
}

function parseSignature(sig: string): Buffer {
  const trimmed = sig.trim();
  const looksHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0;
  return Buffer.from(trimmed, looksHex ? 'hex' : 'base64');
}

function getClientIp(req: Request): string {
  const ip = req.ip || (req.connection as unknown as { remoteAddress?: string }).remoteAddress;
  return String(ip ?? '');
}

function getRouteLabel(req: Request): string {
  const route = (req as unknown as { route?: { path?: unknown } }).route;
  if (route && typeof route.path === 'string') return route.path;
  return 'unknown';
}

async function incrWithTtl(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string,
  ttlSeconds: number,
): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

export function signatureAuth(options: SignatureAuthOptions = {}) {
  const required = options.required ?? true;
  const nonceTtlSeconds = options.nonceTtlSeconds ?? 600;
  const enforceInLocal = options.enforceInLocal ?? false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if ((!enforceInLocal && process.env.NETWORK === 'local') || process.env.NODE_ENV === 'test') {
      next();
      return;
    }

    const start = process.hrtime.bigint();
    const route = getRouteLabel(req);
    const record = (status: number, failureReason?: string): void => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      tgAuthSignatureRequestsTotal.inc({ status: String(status), route });
      tgAuthSignatureLatencyMs.observe({ status: String(status), route }, ms);
      if (failureReason) {
        tgAuthSignatureFailuresTotal.inc({ reason: failureReason, route });
        if (!process.env.JEST_WORKER_ID) {
          logger.warn({ route, status, reason: failureReason }, 'signature auth failed');
        }
      }
    };

    const publicKey = String(req.header('x-tg-public-key') ?? '');
    const timestampStr = String(req.header('x-tg-timestamp') ?? '');
    const nonce = String(req.header('x-tg-nonce') ?? '');
    const signatureStr = String(req.header('x-tg-signature') ?? '');
    const ip = getClientIp(req);

    const fail = async (error: string): Promise<void> => {
      let finalStatus = 401;
      let reason = error;
      try {
        const redis = await getRedisClient();
        const ttlSeconds = 60;
        const ipCount = ip ? await incrWithTtl(redis, `tg:authfail:ip:${ip}`, ttlSeconds) : 0;
        const pkCount = publicKey
          ? await incrWithTtl(redis, `tg:authfail:pk:${publicKey}`, ttlSeconds)
          : 0;

        if (ipCount > 30 || pkCount > 10) {
          finalStatus = 429;
          reason = 'rate limit exceeded';
          res.status(429).json({ error: 'rate limit exceeded' });
          record(finalStatus, reason);
          return;
        }
      } catch (err) {
        void err;
      }

      record(finalStatus, reason);
      res.status(401).json({ error });
    };

    if (!publicKey || !timestampStr || !nonce || !signatureStr) {
      if (required) {
        await fail('missing signature headers');
        return;
      }
      next();
      return;
    }

    const timestamp = Number(timestampStr);
    if (!Number.isFinite(timestamp)) {
      await fail('invalid timestamp');
      return;
    }

    if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
      await fail('timestamp outside allowed window');
      return;
    }

    if (options.matchBodyField) {
      const bodyValue = (req.body ?? {})[options.matchBodyField];
      if (typeof bodyValue === 'string' && bodyValue !== publicKey) {
        await fail(`public key mismatch for ${options.matchBodyField}`);
        return;
      }
    }

    const rawBody = Buffer.isBuffer((req as unknown as { rawBody?: unknown }).rawBody)
      ? ((req as unknown as { rawBody: Buffer }).rawBody as Buffer)
      : Buffer.from(JSON.stringify(req.body ?? {}));
    const bodyHash = sha256Hex(rawBody);

    const payload = `${req.method.toUpperCase()}\n${getRequestPath(req)}\n${timestampStr}\n${nonce}\n${bodyHash}`;
    let kp: Keypair;
    try {
      kp = Keypair.fromPublicKey(publicKey);
    } catch {
      await fail('invalid public key');
      return;
    }

    let signature: Buffer;
    try {
      signature = parseSignature(signatureStr);
    } catch {
      await fail('invalid signature encoding');
      return;
    }

    const ok = kp.verify(Buffer.from(payload), signature);
    if (!ok) {
      await fail('invalid signature');
      return;
    }

    let redis: Awaited<ReturnType<typeof getRedisClient>>;
    try {
      redis = await getRedisClient();
    } catch {
      record(503, 'nonce store unavailable');
      res.status(503).json({ error: 'nonce store unavailable' });
      return;
    }

    const serverNonceKey = `tg:nonce2:${publicKey}:${nonce}`;
    const serverNonceTimestamp = await redis.sendCommand(['GETDEL', serverNonceKey]);
    if (serverNonceTimestamp !== null && serverNonceTimestamp !== undefined) {
      if (String(serverNonceTimestamp) !== timestampStr) {
        await fail('invalid nonce');
        return;
      }
    } else if (process.env.TG_ALLOW_CLIENT_NONCE === 'true') {
      const legacyNonceKey = `tg:nonce:${publicKey}:${nonce}`;
      const nonceSet = await redis.set(legacyNonceKey, '1', { NX: true, EX: nonceTtlSeconds });
      if (nonceSet !== 'OK') {
        await fail('replayed nonce');
        return;
      }
    } else {
      await fail('invalid nonce');
      return;
    }

    (req as unknown as { authPublicKey?: string }).authPublicKey = publicKey;
    record(200);
    next();
  };
}
