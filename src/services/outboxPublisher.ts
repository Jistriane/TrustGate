import { RedisClientType } from 'redis';
import { PgOutboxRepository } from '../repositories/outboxRepository';

export interface OutboxPublisherOptions {
  streamKey: string;
  batchSize: number;
}

export class OutboxPublisher {
  constructor(
    private readonly outbox: PgOutboxRepository,
    private readonly redis: RedisClientType,
    private readonly options: OutboxPublisherOptions,
  ) {}

  async publishOnce(): Promise<number> {
    const events = await this.outbox.listUnprocessed(this.options.batchSize);
    for (const event of events) {
      try {
        await this.redis.xAdd(
          this.options.streamKey,
          '*',
          {
            id: event.id,
            type: event.type,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            payload: JSON.stringify(event.payload ?? null),
          },
          { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 10000 } },
        );
        await this.outbox.markProcessed(event.id);
      } catch (err) {
        await this.outbox.markFailed(event.id, (err as Error).message);
      }
    }
    return events.length;
  }
}

