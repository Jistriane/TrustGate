import { logger } from '../config/logger';

export type RateLimitStorage = 'memory' | 'redis';

export interface RateLimitConfig {
  storage: RateLimitStorage;
  disableAll: boolean;
  redisUrl?: string;
}

export function parseRateLimitConfig(envOverride: Record<string, string | undefined> = process.env): RateLimitConfig {
  const storageRaw = (envOverride.RATE_LIMIT_STORAGE ?? 'memory').toLowerCase().trim();
  const requestedStorage: RateLimitStorage = storageRaw === 'redis' ? 'redis' : 'memory';
  const disableAllRaw = (envOverride.RATE_LIMIT_DISABLE_ALL ?? 'false').toLowerCase().trim();
  const disableAll = disableAllRaw === 'true' || disableAllRaw === '1';
  const redisUrl = envOverride.REDIS_URL;
  if (requestedStorage === 'redis' && !redisUrl && !disableAll) {
    logger.warn(
      { REDIS_URL_isSet: Boolean(redisUrl) },
      'rate-limit: storage=redis requires REDIS_URL; falling back to memory in-process store this boot. Set RATE_LIMIT_STORAGE=memory to silence, or set REDIS_URL.',
    );
  }
  const storage: RateLimitStorage = requestedStorage === 'redis' && redisUrl ? 'redis' : 'memory';
  return { storage, disableAll, redisUrl };
}
