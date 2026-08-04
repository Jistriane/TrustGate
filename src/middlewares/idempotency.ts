import { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import { PgIdempotencyRepository } from '../repositories/idempotencyRepository';

export interface IdempotencyOptions {
  scope: string;
  publicKeyFrom?: 'auth' | { bodyField: string };
  requireHeader?: boolean;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function getRequestPath(req: Request): string {
  const original = req.originalUrl ?? req.url;
  return original.split('?')[0] ?? '';
}

export function idempotency(repo: PgIdempotencyRepository, options: IdempotencyOptions) {
  const requireHeader = options.requireHeader ?? true;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = String(req.header('Idempotency-Key') ?? '');
    if (!key) {
      if (requireHeader) {
        res.status(400).json({ error: 'missing Idempotency-Key header' });
        return;
      }
      next();
      return;
    }

    let publicKey: string | undefined;
    if (options.publicKeyFrom === 'auth') {
      publicKey = (req as unknown as { authPublicKey?: string }).authPublicKey;
    } else if (options.publicKeyFrom && 'bodyField' in options.publicKeyFrom) {
      const value = (req.body ?? {})[options.publicKeyFrom.bodyField];
      if (typeof value === 'string') {
        publicKey = value;
      }
    }

    const rawBody = Buffer.isBuffer((req as unknown as { rawBody?: unknown }).rawBody)
      ? ((req as unknown as { rawBody: Buffer }).rawBody as Buffer)
      : Buffer.from(JSON.stringify(req.body ?? {}));
    const bodyHash = sha256Hex(rawBody);
    const requestHash = sha256Hex(Buffer.from(`${req.method.toUpperCase()}\n${getRequestPath(req)}\n${bodyHash}`));

    const existing = await repo.find(key);
    if (existing) {
      if (existing.scope !== options.scope) {
        res.status(409).json({ error: 'idempotency key scope mismatch' });
        return;
      }
      if ((existing.publicKey ?? null) !== (publicKey ?? null)) {
        res.status(409).json({ error: 'idempotency key owner mismatch' });
        return;
      }
      if (existing.requestHash !== requestHash) {
        res.status(409).json({ error: 'idempotency key reused with different request' });
        return;
      }
      res.status(existing.responseCode).json(existing.responseBody);
      return;
    }

    let capturedBody: unknown | undefined;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      capturedBody = body;
      return originalJson(body);
    }) as never;

    res.on('finish', () => {
      if (capturedBody === undefined) return;
      if (res.statusCode >= 500) return;
      repo
        .insert({
          key,
          scope: options.scope,
          publicKey,
          requestHash,
          responseCode: res.statusCode,
          responseBody: capturedBody,
        })
        .catch(() => undefined);
    });

    next();
  };
}

