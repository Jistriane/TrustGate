import { Pool } from 'pg';

export type EventConsumptionStatus = 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export interface EventConsumptionRecord {
  handlerName: string;
  eventId: string;
  streamEntryId?: string;
  status: EventConsumptionStatus;
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class PgEventConsumptionRepository {
  constructor(private readonly pool: Pool) {}

  async tryStart(args: {
    handlerName: string;
    eventId: string;
    streamEntryId?: string;
    maxAttempts: number;
    nextRetryAt: Date | null;
  }): Promise<{ started: boolean; record?: EventConsumptionRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const select = await client.query<{
        handler_name: string;
        event_id: string;
        stream_entry_id: string | null;
        status: EventConsumptionStatus;
        attempts: number;
        last_error: string | null;
        next_retry_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `select handler_name, event_id, stream_entry_id, status, attempts, last_error, next_retry_at, created_at, updated_at
         from event_consumptions
         where handler_name = $1 and event_id = $2
         for update`,
        [args.handlerName, args.eventId],
      );

      const existing = select.rows[0];
      if (!existing) {
        const inserted = await client.query<{
          handler_name: string;
          event_id: string;
          stream_entry_id: string | null;
          status: EventConsumptionStatus;
          attempts: number;
          last_error: string | null;
          next_retry_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `insert into event_consumptions (handler_name, event_id, stream_entry_id, status, attempts, next_retry_at)
           values ($1, $2, $3, 'PROCESSING', 1, $4)
           returning handler_name, event_id, stream_entry_id, status, attempts, last_error, next_retry_at, created_at, updated_at`,
          [args.handlerName, args.eventId, args.streamEntryId ?? null, args.nextRetryAt],
        );
        await client.query('commit');
        return { started: true, record: this.map(inserted.rows[0]) };
      }

      if (existing.status === 'SUCCEEDED') {
        await client.query('commit');
        return { started: false, record: this.map(existing) };
      }

      if (existing.attempts >= args.maxAttempts) {
        await client.query('commit');
        return { started: false, record: this.map(existing) };
      }

      const now = new Date();
      if (existing.next_retry_at && existing.next_retry_at.getTime() > now.getTime()) {
        await client.query('commit');
        return { started: false, record: this.map(existing) };
      }

      const updated = await client.query<{
        handler_name: string;
        event_id: string;
        stream_entry_id: string | null;
        status: EventConsumptionStatus;
        attempts: number;
        last_error: string | null;
        next_retry_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `update event_consumptions
         set status = 'PROCESSING',
             attempts = attempts + 1,
             stream_entry_id = coalesce($3, stream_entry_id),
             updated_at = now()
         where handler_name = $1 and event_id = $2
         returning handler_name, event_id, stream_entry_id, status, attempts, last_error, next_retry_at, created_at, updated_at`,
        [args.handlerName, args.eventId, args.streamEntryId ?? null],
      );

      await client.query('commit');
      return { started: true, record: this.map(updated.rows[0]) };
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async markSucceeded(handlerName: string, eventId: string): Promise<void> {
    await this.pool.query(
      `update event_consumptions
       set status = 'SUCCEEDED', last_error = null, next_retry_at = null, updated_at = now()
       where handler_name = $1 and event_id = $2`,
      [handlerName, eventId],
    );
  }

  async markFailed(args: {
    handlerName: string;
    eventId: string;
    error: string;
    nextRetryAt: Date | null;
  }): Promise<void> {
    await this.pool.query(
      `update event_consumptions
       set status = 'FAILED', last_error = $3, next_retry_at = $4, updated_at = now()
       where handler_name = $1 and event_id = $2`,
      [args.handlerName, args.eventId, args.error, args.nextRetryAt],
    );
  }

  async listDueRetries(args: { handlerName: string; limit: number }): Promise<EventConsumptionRecord[]> {
    const res = await this.pool.query<{
      handler_name: string;
      event_id: string;
      stream_entry_id: string | null;
      status: EventConsumptionStatus;
      attempts: number;
      last_error: string | null;
      next_retry_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select handler_name, event_id, stream_entry_id, status, attempts, last_error, next_retry_at, created_at, updated_at
       from event_consumptions
       where handler_name = $1 and status = 'FAILED' and (next_retry_at is null or next_retry_at <= now())
       order by coalesce(next_retry_at, updated_at) asc
       limit $2`,
      [args.handlerName, args.limit],
    );
    return res.rows.map((row) => this.map(row));
  }

  private map(row: {
    handler_name: string;
    event_id: string;
    stream_entry_id: string | null;
    status: EventConsumptionStatus;
    attempts: number;
    last_error: string | null;
    next_retry_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }): EventConsumptionRecord {
    return {
      handlerName: row.handler_name,
      eventId: row.event_id,
      streamEntryId: row.stream_entry_id ?? undefined,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
      nextRetryAt: row.next_retry_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
