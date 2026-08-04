import { Pool } from 'pg';

export interface TaskResultRecord {
  taskId: string;
  payload: unknown;
  payloadHash: string;
  createdAt: string;
}

export interface TaskResultRepositoryLike {
  upsert(result: Omit<TaskResultRecord, 'createdAt'>): Promise<void>;
  findByTaskId(taskId: string): Promise<TaskResultRecord | undefined>;
}

interface TaskResultRow {
  task_id: string;
  payload_json: unknown;
  payload_hash: string;
  created_at: Date;
}

export class InMemoryTaskResultRepository implements TaskResultRepositoryLike {
  private readonly results = new Map<string, TaskResultRecord>();

  async upsert(result: Omit<TaskResultRecord, 'createdAt'>): Promise<void> {
    this.results.set(result.taskId, { ...result, createdAt: new Date().toISOString() });
  }

  async findByTaskId(taskId: string): Promise<TaskResultRecord | undefined> {
    return this.results.get(taskId);
  }
}

export class PgTaskResultRepository implements TaskResultRepositoryLike {
  constructor(private readonly pool: Pool) {}

  async upsert(result: Omit<TaskResultRecord, 'createdAt'>): Promise<void> {
    await this.pool.query(
      `
        insert into task_results (task_id, payload_json, payload_hash)
        values ($1, $2, $3)
        on conflict (task_id) do update set
          payload_json = excluded.payload_json,
          payload_hash = excluded.payload_hash
      `,
      [result.taskId, result.payload, result.payloadHash],
    );
  }

  async findByTaskId(taskId: string): Promise<TaskResultRecord | undefined> {
    const res = await this.pool.query<TaskResultRow>(
      `
        select task_id, payload_json, payload_hash, created_at
        from task_results
        where task_id = $1
        limit 1
      `,
      [taskId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      payload: row.payload_json,
      payloadHash: row.payload_hash,
      createdAt: row.created_at.toISOString(),
    };
  }
}
