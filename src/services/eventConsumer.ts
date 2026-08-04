import { RedisClientType } from 'redis';

export interface EventConsumerOptions {
  streamKey: string;
  group: string;
  consumer: string;
  blockMs: number;
  count: number;
}

type StreamEntry = {
  id: string;
  fields: Record<string, string>;
};

function parseEntries(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: StreamEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const id = String(item[0]);
    const rawFields = item[1];
    const fields: Record<string, string> = {};
    if (Array.isArray(rawFields)) {
      for (let i = 0; i < rawFields.length; i += 2) {
        fields[String(rawFields[i])] = String(rawFields[i + 1]);
      }
    }
    entries.push({ id, fields });
  }
  return entries;
}

export class EventConsumer {
  private claimCursor = '0-0';

  constructor(
    private readonly redis: RedisClientType,
    private readonly options: EventConsumerOptions,
  ) {}

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.sendCommand([
        'XGROUP',
        'CREATE',
        this.options.streamKey,
        this.options.group,
        '$',
        'MKSTREAM',
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/BUSYGROUP/i.test(msg)) {
        throw err;
      }
    }
  }

  async pollOnce(handler: (entry: StreamEntry) => Promise<void>): Promise<number> {
    const res = await this.redis.sendCommand([
      'XREADGROUP',
      'GROUP',
      this.options.group,
      this.options.consumer,
      'COUNT',
      String(this.options.count),
      'BLOCK',
      String(this.options.blockMs),
      'STREAMS',
      this.options.streamKey,
      '>',
    ]);

    if (!Array.isArray(res) || res.length === 0) return 0;
    const stream = res[0];
    if (!Array.isArray(stream) || stream.length < 2) return 0;

    const entries = parseEntries(stream[1]);
    for (const entry of entries) {
      await handler(entry);
    }
    return entries.length;
  }

  async autoClaimOnce(minIdleMs: number, handler: (entry: StreamEntry) => Promise<void>): Promise<number> {
    const res = await this.redis.sendCommand([
      'XAUTOCLAIM',
      this.options.streamKey,
      this.options.group,
      this.options.consumer,
      String(minIdleMs),
      this.claimCursor,
      'COUNT',
      String(this.options.count),
    ]);

    if (!Array.isArray(res) || res.length < 2) return 0;
    this.claimCursor = String(res[0] ?? this.claimCursor);
    const entries = parseEntries(res[1]);
    for (const entry of entries) {
      await handler(entry);
    }
    return entries.length;
  }

  async ack(entryId: string): Promise<void> {
    await this.redis.sendCommand(['XACK', this.options.streamKey, this.options.group, entryId]);
  }
}
