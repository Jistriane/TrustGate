import { Pool } from 'pg';

export interface IdempotencyRecord {
  key: string;
  scope: string;
  publicKey?: string;
  requestHash: string;
  responseCode: number;
  responseBody: unknown;
  createdAt: string;
}

interface IdempotencyRow {
  key: string;
  scope: string;
  public_key: string | null;
  request_hash: string;
  response_code: number;
  response_body: unknown;
  created_at: Date;
}

export class PgIdempotencyRepository {
  constructor(private readonly pool: Pool) {}

  async find(key: string): Promise<IdempotencyRecord | undefined> {
    const res = await this.pool.query<IdempotencyRow>(
      `
        select key, scope, public_key, request_hash, response_code, response_body, created_at
        from idempotency_keys
        where key = $1
        limit 1
      `,
      [key],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      key: row.key,
      scope: row.scope,
      publicKey: row.public_key ?? undefined,
      requestHash: row.request_hash,
      responseCode: row.response_code,
      responseBody: row.response_body,
      createdAt: row.created_at.toISOString(),
    };
  }

  async insert(record: Omit<IdempotencyRecord, 'createdAt'>): Promise<void> {
    await this.pool.query(
      `
        insert into idempotency_keys (key, scope, public_key, request_hash, response_code, response_body)
        values ($1, $2, $3, $4, $5, $6)
      `,
      [
        record.key,
        record.scope,
        record.publicKey ?? null,
        record.requestHash,
        record.responseCode,
        record.responseBody,
      ],
    );
  }
}

