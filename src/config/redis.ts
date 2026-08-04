import { createClient, RedisClientType } from 'redis';

let client: RedisClientType | undefined;

export async function getRedisClient(): Promise<RedisClientType> {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set');
  }
  if (!client) {
    client = createClient({ url });
    await client.connect();
  }
  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (client) {
    const c = client;
    client = undefined;
    await c.quit();
  }
}

