import { Pool } from 'pg';

export interface ExecutorRecord {
  publicKey: string;
  metadataUri: string;
  registeredAt: string;
}

export interface ExecutorRepositoryLike {
  save(record: ExecutorRecord): Promise<void>;
  findByPublicKey(publicKey: string): Promise<ExecutorRecord | undefined>;
  list(): Promise<ExecutorRecord[]>;
}

export class InMemoryExecutorRepository implements ExecutorRepositoryLike {
  private readonly executors = new Map<string, ExecutorRecord>();

  async save(record: ExecutorRecord): Promise<void> {
    this.executors.set(record.publicKey, record);
  }

  async findByPublicKey(publicKey: string): Promise<ExecutorRecord | undefined> {
    return this.executors.get(publicKey);
  }

  async list(): Promise<ExecutorRecord[]> {
    return Array.from(this.executors.values());
  }
}

interface ExecutorRow {
  public_key: string;
  metadata_uri: string | null;
  registered_at: Date;
}

export class PgExecutorRepository implements ExecutorRepositoryLike {
  constructor(private readonly pool: Pool) {}

  async save(record: ExecutorRecord): Promise<void> {
    await this.pool.query(
      `
        insert into executors (public_key, metadata_uri, registered_at)
        values ($1, $2, $3)
        on conflict (public_key) do update set
          metadata_uri = excluded.metadata_uri
      `,
      [record.publicKey, record.metadataUri, record.registeredAt],
    );
  }

  async findByPublicKey(publicKey: string): Promise<ExecutorRecord | undefined> {
    const res = await this.pool.query<ExecutorRow>(
      `
        select public_key, metadata_uri, registered_at
        from executors
        where public_key = $1
        limit 1
      `,
      [publicKey],
    );
    const row = res.rows[0];
    if (!row || !row.metadata_uri) return undefined;
    return {
      publicKey: row.public_key,
      metadataUri: row.metadata_uri,
      registeredAt: row.registered_at.toISOString(),
    };
  }

  async list(): Promise<ExecutorRecord[]> {
    const res = await this.pool.query<ExecutorRow>(
      `
        select public_key, metadata_uri, registered_at
        from executors
        order by registered_at desc
      `,
    );
    return res.rows
      .filter((r) => Boolean(r.metadata_uri))
      .map((row) => ({
        publicKey: row.public_key,
        metadataUri: row.metadata_uri ?? '',
        registeredAt: row.registered_at.toISOString(),
      }));
  }
}

export { InMemoryExecutorRepository as ExecutorRepository };
