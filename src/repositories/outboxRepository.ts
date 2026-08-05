import { Pool } from 'pg';

export interface OutboxEvent {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: string;
  processedAt?: string;
  attempts: number;
  lastError?: string;
}

interface OutboxRow {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: unknown;
  created_at: Date;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
}

export class PgOutboxRepository {
  constructor(private readonly pool: Pool) {}

  async insert(event: Omit<OutboxEvent, 'createdAt' | 'processedAt' | 'attempts' | 'lastError'>): Promise<void> {
    await this.pool.query(
      `
        insert into outbox_events (id, type, aggregate_type, aggregate_id, payload_json)
        values ($1, $2, $3, $4, $5)
      `,
      [event.id, event.type, event.aggregateType, event.aggregateId, event.payload],
    );
  }

  async listUnprocessed(limit: number): Promise<OutboxEvent[]> {
    const res = await this.pool.query<OutboxRow>(
      `
        select id, type, aggregate_type, aggregate_id, payload_json, created_at, processed_at, attempts, last_error
        from outbox_events
        where processed_at is null
        order by created_at asc
        limit $1
      `,
      [limit],
    );
    return res.rows.map((row) => ({
      id: row.id,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload_json,
      createdAt: row.created_at.toISOString(),
      processedAt: row.processed_at?.toISOString(),
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
    }));
  }

  async countUnprocessed(): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from outbox_events
        where processed_at is null
      `,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async countFailed(): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      `
        select count(*)::text as count
        from outbox_events
        where processed_at is null
          and attempts > 0
      `,
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async findById(id: string): Promise<OutboxEvent | undefined> {
    const res = await this.pool.query<OutboxRow>(
      `
        select id, type, aggregate_type, aggregate_id, payload_json, created_at, processed_at, attempts, last_error
        from outbox_events
        where id = $1
        limit 1
      `,
      [id],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload_json,
      createdAt: row.created_at.toISOString(),
      processedAt: row.processed_at?.toISOString(),
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
    };
  }

  async markProcessed(id: string): Promise<void> {
    await this.pool.query(
      `
        update outbox_events
        set processed_at = now()
        where id = $1 and processed_at is null
      `,
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `
        update outbox_events
        set attempts = attempts + 1,
            last_error = $2
        where id = $1
      `,
      [id, error],
    );
  }
}
