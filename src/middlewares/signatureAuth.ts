import { NextFunction, Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { getRedisClient } from '../config/redis';

export interface SignatureAuthOptions {
  required?: boolean;
  matchBodyField?: string;
  nonceTtlSeconds?: number;
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
  try {
    return Buffer.from(trimmed, 'hex');
  } catch {
    return Buffer.from(trimmed, 'base64');
  }
}

export function signatureAuth(options: SignatureAuthOptions = {}) {
  const required = options.required ?? true;
  const nonceTtlSeconds = options.nonceTtlSeconds ?? 600;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (process.env.NETWORK === 'local' || process.env.NODE_ENV === 'test') {
      next();
      return;
    }

    const publicKey = String(req.header('x-tg-public-key') ?? '');
    const timestampStr = String(req.header('x-tg-timestamp') ?? '');
    const nonce = String(req.header('x-tg-nonce') ?? '');
    const signatureStr = String(req.header('x-tg-signature') ?? '');

    if (!publicKey || !timestampStr || !nonce || !signatureStr) {
      if (required) {
        res.status(401).json({ error: 'missing signature headers' });
        return;
      }
      next();
      return;
    }

    const timestamp = Number(timestampStr);
    if (!Number.isFinite(timestamp)) {
      res.status(401).json({ error: 'invalid timestamp' });
      return;
    }

    if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
      res.status(401).json({ error: 'timestamp outside allowed window' });
      return;
    }

    if (options.matchBodyField) {
      const bodyValue = (req.body ?? {})[options.matchBodyField];
      if (typeof bodyValue === 'string' && bodyValue !== publicKey) {
        res.status(401).json({ error: `public key mismatch for ${options.matchBodyField}` });
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
      res.status(401).json({ error: 'invalid public key' });
      return;
    }

    let signature: Buffer;
    try {
      signature = parseSignature(signatureStr);
    } catch {
      res.status(401).json({ error: 'invalid signature encoding' });
      return;
    }

    const ok = kp.verify(Buffer.from(payload), signature);
    if (!ok) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const redis = await getRedisClient();
    const nonceKey = `tg:nonce:${publicKey}:${nonce}`;
    const nonceSet = await redis.set(nonceKey, '1', { NX: true, EX: nonceTtlSeconds });
    if (nonceSet !== 'OK') {
      res.status(401).json({ error: 'replayed nonce' });
      return;
    }

    (req as unknown as { authPublicKey?: string }).authPublicKey = publicKey;
    next();
  };
}
