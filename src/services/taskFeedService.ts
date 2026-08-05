import { EventEmitter } from 'events';
import { Keypair } from '@stellar/stellar-sdk';
import { Task } from '../models/task';
import { logger } from '../config/logger';

export interface FeedTick {
  sequence: number;
  taskId: string;
  timestamp: string;
  signature: string;
}

/**
 * Broadcasts new tasks to executors over a free, unauthenticated SSE feed
 * (`/feed/stream`). Each tick is signed with the marketplace's key so
 * subscribers can verify it wasn't tampered with in transit, but no payment
 * is involved — this is a signed notification log, not an MPP payment
 * channel (there's no on-chain deposit, no cumulative commitment, no
 * counterparty settlement).
 */
export class TaskFeedService extends EventEmitter {
  private sequence = 0;

  constructor(private readonly signingKey: Keypair) {
    super();
  }

  async publishTask(task: Task): Promise<FeedTick> {
    const sequence = ++this.sequence;
    const timestamp = new Date().toISOString();
    const payload = `${sequence}:${task.id}:${timestamp}`;
    const signature = this.signingKey.sign(Buffer.from(payload)).toString('hex');

    const tick: FeedTick = { sequence, taskId: task.id, timestamp, signature };

    logger.info(
      {
        sequence: tick.sequence,
        taskId: tick.taskId,
        signingPublicKey: this.signingKey.publicKey(),
        signaturePrefix: tick.signature.slice(0, 16),
      },
      '[Task Feed] tick — task published',
    );

    this.emit('tick', tick);

    return tick;
  }
}
