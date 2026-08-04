import cron, { ScheduledTask } from 'node-cron';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { EscrowServiceLike } from './escrowService';

export interface TimeoutRunResult {
  expiredTaskIds: string[];
}

/**
 * Punishes abandoned tasks: any task still ASSIGNED past its deadline gets
 * its winning bid's collateral confiscated and its status flipped to
 * EXPIRED.
 */
export class TimeoutService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly bidRepository: BidRepository,
    private readonly escrowService: EscrowServiceLike,
  ) {}

  async runOnce(): Promise<TimeoutRunResult> {
    const now = Date.now();
    const expiredTaskIds: string[] = [];

    const expiredAssignedTasks = this.taskRepository
      .list()
      .filter((task) => task.status === 'ASSIGNED' && new Date(task.deadline).getTime() < now);

    for (const task of expiredAssignedTasks) {
      const winningBid = this.bidRepository
        .findByTaskId(task.id)
        .find((bid) => bid.status === 'SELECTED');

      if (!winningBid) {
        console.warn(`[Timeout] task ${task.id} expired but has no selected bid — skipping`);
        continue;
      }

      try {
        const result = await this.escrowService.confiscate(winningBid.escrowId, winningBid.collateral);
        console.log(
          `[Timeout] task ${task.id} expired — confiscated escrow ${winningBid.escrowId} ` +
            `(requester: ${result.requesterShare}, marketplace: ${result.marketplaceShare}, dispute ${result.disputeId})`,
        );
      } catch (err) {
        console.error(`[Timeout] failed to confiscate collateral for task ${task.id}:`, err);
        continue;
      }

      this.taskRepository.save({ ...task, status: 'EXPIRED' });
      expiredTaskIds.push(task.id);
    }

    return { expiredTaskIds };
  }

  schedule(cronExpression: string = '*/5 * * * *'): ScheduledTask {
    return cron.schedule(cronExpression, () => {
      this.runOnce().catch((err) => console.error('[Timeout] scheduled job failed:', err));
    });
  }
}
