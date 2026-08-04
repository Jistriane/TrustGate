import { Bid } from '../models/bid';
import { Pool } from 'pg';

export interface BidRepositoryLike {
  save(bid: Bid): Promise<void>;
  findById(id: string): Promise<Bid | undefined>;
  findByTaskId(taskId: string): Promise<Bid[]>;
  list(): Promise<Bid[]>;
}

export class InMemoryBidRepository implements BidRepositoryLike {
  private readonly bids = new Map<string, Bid>();

  async save(bid: Bid): Promise<void> {
    this.bids.set(bid.id, bid);
  }

  async findById(id: string): Promise<Bid | undefined> {
    return this.bids.get(id);
  }

  async findByTaskId(taskId: string): Promise<Bid[]> {
    return (await this.list()).filter((bid) => bid.taskId === taskId);
  }

  async list(): Promise<Bid[]> {
    return Array.from(this.bids.values());
  }
}

interface BidRow {
  id: string;
  task_id: string;
  executor_public_key: string;
  amount_stroops: string;
  collateral_stroops: string;
  escrow_id: string;
  status: Bid['status'];
  created_at: Date;
}

export class PgBidRepository implements BidRepositoryLike {
  constructor(private readonly pool: Pool) {}

  async save(bid: Bid): Promise<void> {
    await this.pool.query(
      `
        insert into bids (
          id, task_id, executor_public_key, amount_stroops, collateral_stroops, escrow_id, status, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (id) do update set
          task_id = excluded.task_id,
          executor_public_key = excluded.executor_public_key,
          amount_stroops = excluded.amount_stroops,
          collateral_stroops = excluded.collateral_stroops,
          escrow_id = excluded.escrow_id,
          status = excluded.status
      `,
      [
        bid.id,
        bid.taskId,
        bid.executorPublicKey,
        bid.amountStroops.toString(),
        bid.collateralStroops.toString(),
        bid.escrowId,
        bid.status,
        bid.createdAt,
      ],
    );
  }

  async findById(id: string): Promise<Bid | undefined> {
    const res = await this.pool.query<BidRow>(
      `
        select id, task_id, executor_public_key, amount_stroops, collateral_stroops, escrow_id, status, created_at
        from bids
        where id = $1
        limit 1
      `,
      [id],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      executorPublicKey: row.executor_public_key,
      amountStroops: BigInt(row.amount_stroops),
      collateralStroops: BigInt(row.collateral_stroops),
      escrowId: row.escrow_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    };
  }

  async findByTaskId(taskId: string): Promise<Bid[]> {
    const res = await this.pool.query<BidRow>(
      `
        select id, task_id, executor_public_key, amount_stroops, collateral_stroops, escrow_id, status, created_at
        from bids
        where task_id = $1
        order by created_at asc
      `,
      [taskId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      executorPublicKey: row.executor_public_key,
      amountStroops: BigInt(row.amount_stroops),
      collateralStroops: BigInt(row.collateral_stroops),
      escrowId: row.escrow_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async list(): Promise<Bid[]> {
    const res = await this.pool.query<BidRow>(
      `
        select id, task_id, executor_public_key, amount_stroops, collateral_stroops, escrow_id, status, created_at
        from bids
        order by created_at desc
      `,
    );
    return res.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      executorPublicKey: row.executor_public_key,
      amountStroops: BigInt(row.amount_stroops),
      collateralStroops: BigInt(row.collateral_stroops),
      escrowId: row.escrow_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

export { InMemoryBidRepository as BidRepository };
