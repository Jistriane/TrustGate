import { describe, expect, it, jest } from '@jest/globals';
import { EventConsumer } from './eventConsumer';

describe('EventConsumer', () => {
  it('avoids concurrent autoClaimOnce calls within the same instance', async () => {
    let resolveSend: ((value: unknown) => void) | undefined;
    const sendPromise = new Promise<unknown>((resolve) => {
      resolveSend = resolve;
    });

    const redis = {
      sendCommand: jest.fn().mockReturnValueOnce(sendPromise),
    } as unknown as import('redis').RedisClientType;

    const consumer = new EventConsumer(redis, {
      streamKey: 's',
      group: 'g',
      consumer: 'c',
      blockMs: 1,
      count: 10,
    });

    const p1 = consumer.autoClaimOnce(30_000, async () => {});
    const p2 = consumer.autoClaimOnce(30_000, async () => {});

    await expect(p2).resolves.toBe(0);
    expect((redis as unknown as { sendCommand: jest.Mock }).sendCommand).toHaveBeenCalledTimes(1);

    resolveSend?.([
      '1-0',
      [
        ['0-1', ['id', 'e1', 'type', 't', 'payload', '{}']],
      ],
    ]);

    await expect(p1).resolves.toBe(1);
  });
});

