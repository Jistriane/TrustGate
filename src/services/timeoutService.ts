import cron, { ScheduledTask } from 'node-cron';
import { TaskRepositoryLike } from '../repositories/taskRepository';
import { BidRepositoryLike } from '../repositories/bidRepository';
import { EscrowServiceLike } from './escrowService';
import { formatUsdcStroopsToDecimal } from '../utils/money';
import { OutboxService } from './outboxService';
import { logger } from '../config/logger';

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
    private readonly taskRepository: TaskRepositoryLike,
    private readonly bidRepository: BidRepositoryLike,
    private readonly escrowService: EscrowServiceLike,
    private readonly outbox?: OutboxService,
  ) {}

  async runOnce(): Promise<TimeoutRunResult> {
    const now = Date.now();
    const expiredTaskIds: string[] = [];

    const expiredAssignedTasks = (await this.taskRepository.list()).filter(
      (task) => task.status === 'ASSIGNED' && new Date(task.deadline).getTime() < now,
    );

    for (const task of expiredAssignedTasks) {
      const winningBid = (await this.bidRepository.findByTaskId(task.id)).find(
        (bid) => bid.status === 'SELECTED',
      );

      if (!winningBid) {
        logger.warn({ taskId: task.id }, '[Timeout] task expired but has no selected bid — skipping');
        continue;
      }

      try {
        const collateralAmount = Number(formatUsdcStroopsToDecimal(winningBid.collateralStroops));
        const result = await this.escrowService.confiscate(winningBid.escrowId, collateralAmount);
        logger.info(
          {
            taskId: task.id,
            escrowId: winningBid.escrowId,
            requesterShare: result.requesterShare,
            marketplaceShare: result.marketplaceShare,
            disputeId: result.disputeId,
          },
          '[Timeout] task expired — confiscated escrow',
        );
      } catch (err) {
        logger.error({ err, taskId: task.id }, '[Timeout] failed to confiscate collateral');
        continue;
      }

      const updatedTask = { ...task, status: 'EXPIRED' as const };
      await this.taskRepository.save(updatedTask);
      await this.outbox?.emit({
        type: 'task_expired',
        aggregateType: 'task',
        aggregateId: updatedTask.id,
        payload: { taskId: updatedTask.id },
      });
      expiredTaskIds.push(task.id);
    }

    return { expiredTaskIds };
  }

  schedule(cronExpression: string = '*/5 * * * *'): ScheduledTask {
    return cron.schedule(cronExpression, () => {
      this.runOnce().catch((err) => logger.error({ err }, '[Timeout] scheduled job failed'));
    });
  }
}
