import { Task } from '../models/task';
import { Pool } from 'pg';

export interface TaskRepositoryLike {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | undefined>;
  list(): Promise<Task[]>;
  listAssignedDeadlineBefore(deadlineMax: string | Date): Promise<Task[]>;
}

export class InMemoryTaskRepository implements TaskRepositoryLike {
  private readonly tasks = new Map<string, Task>();

  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async list(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  async listAssignedDeadlineBefore(deadlineMax: string | Date): Promise<Task[]> {
    const cutoff = deadlineMax instanceof Date ? deadlineMax.getTime() : new Date(deadlineMax).getTime();
    return Array.from(this.tasks.values()).filter((task) => {
      if (task.status !== 'ASSIGNED') return false;
      const d = new Date(task.deadline).getTime();
      return d < cutoff;
    });
  }
}

interface TaskRow {
  id: string;
  requester_public_key: string;
  reserve_price_stroops: string;
  description: string;
  deadline: Date;
  status: Task['status'];
}

export class PgTaskRepository implements TaskRepositoryLike {
  constructor(private readonly pool: Pool) {}

  /**
   * RECOMMENDED SQL indexes (avoid seq scan in production with >10k tasks):
   *   create index concurrently if not exists idx_tasks_status_deadline
   *     on tasks (status, deadline);
   *   create index concurrently if not exists idx_tasks_created_at
   *     on tasks (created_at desc);
   */

  async save(task: Task): Promise<void> {
    await this.pool.query(
      `
        insert into tasks (id, requester_public_key, reserve_price_stroops, description, deadline, status, updated_at)
        values ($1, $2, $3, $4, $5, $6, now())
        on conflict (id) do update set
          requester_public_key = excluded.requester_public_key,
          reserve_price_stroops = excluded.reserve_price_stroops,
          description = excluded.description,
          deadline = excluded.deadline,
          status = excluded.status,
          updated_at = now()
      `,
      [
        task.id,
        task.requesterPublicKey,
        task.reservePriceStroops.toString(),
        task.description,
        task.deadline,
        task.status,
      ],
    );
  }

  async findById(id: string): Promise<Task | undefined> {
    const res = await this.pool.query<TaskRow>(
      `
        select id, requester_public_key, reserve_price_stroops, description, deadline, status
        from tasks
        where id = $1
        limit 1
      `,
      [id],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      requesterPublicKey: row.requester_public_key,
      reservePriceStroops: BigInt(row.reserve_price_stroops),
      description: row.description,
      deadline: row.deadline.toISOString(),
      status: row.status,
    };
  }

  async list(): Promise<Task[]> {
    const res = await this.pool.query<TaskRow>(
      `
        select id, requester_public_key, reserve_price_stroops, description, deadline, status
        from tasks
        order by created_at desc
      `,
    );
    return res.rows.map((row) => ({
      id: row.id,
      requesterPublicKey: row.requester_public_key,
      reservePriceStroops: BigInt(row.reserve_price_stroops),
      description: row.description,
      deadline: row.deadline.toISOString(),
      status: row.status,
    }));
  }

  async listAssignedDeadlineBefore(deadlineMax: string | Date): Promise<Task[]> {
    const cutoff = deadlineMax instanceof Date ? deadlineMax : new Date(deadlineMax);
    const res = await this.pool.query<TaskRow>(
      `
        select id, requester_public_key, reserve_price_stroops, description, deadline, status
        from tasks
        where status = 'ASSIGNED'
          and deadline < $1
        order by deadline asc
      `,
      [cutoff],
    );
    return res.rows.map((row) => ({
      id: row.id,
      requesterPublicKey: row.requester_public_key,
      reservePriceStroops: BigInt(row.reserve_price_stroops),
      description: row.description,
      deadline: row.deadline.toISOString(),
      status: row.status,
    }));
  }
}

export { InMemoryTaskRepository as TaskRepository };
