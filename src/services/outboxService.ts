import { randomUUID } from 'crypto';
import { PgOutboxRepository } from '../repositories/outboxRepository';

export class OutboxService {
  constructor(private readonly repo: PgOutboxRepository) {}

  async emit(event: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
  }): Promise<void> {
    await this.repo.insert({
      id: randomUUID(),
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    });
  }
}

