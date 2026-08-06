import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepositoryLike } from '../repositories/taskRepository';
import { BidRepositoryLike } from '../repositories/bidRepository';
import { logger } from '../config/logger';

export class TaskNotFoundError extends Error {}
export class TaskNotOpenError extends Error {}
export class NoBidsError extends Error {}
export class AuctionPausedError extends Error {}

export interface SelectWinnerResult {
  task: Task;
  winningBid: Bid;
}

export class AuctionService {
  private readonly pauseAuction: boolean;

  constructor(
    private readonly taskRepository: TaskRepositoryLike,
    private readonly bidRepository: BidRepositoryLike,
    envOverrides?: Partial<{ PAUSE_AUCTION: 'true' | 'false' }>,
  ) {
    const env = envOverrides ?? process.env;
    this.pauseAuction = env.PAUSE_AUCTION === 'true';
  }

  private assertNotPaused() {
    if (this.pauseAuction) {
      throw new AuctionPausedError(
        '[AuctionService.selectWinner] PAUSE_AUCTION=1 (off-chain feature flag). Winner selection is blocked until unpause.',
      );
    }
  }

  async selectWinner(taskId: string): Promise<SelectWinnerResult> {
    this.assertNotPaused();
    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${taskId}`);
    }
    if (task.status !== 'OPEN') {
      throw new TaskNotOpenError(task.status);
    }

    const pendingBids = (await this.bidRepository.findByTaskId(taskId)).filter(
      (bid) => bid.status === 'PENDING',
    );
    if (pendingBids.length === 0) {
      throw new NoBidsError(`No pending bids for task: ${taskId}`);
    }

    const winningBid = pendingBids.reduce((lowest, bid) => {
      if (bid.amountStroops < lowest.amountStroops) return bid;
      if (bid.amountStroops === lowest.amountStroops && bid.createdAt < lowest.createdAt) return bid;
      return lowest;
    });

    const updatedTask: Task = { ...task, status: 'ASSIGNED' };
    await this.taskRepository.save(updatedTask);

    const updatedWinningBid: Bid = { ...winningBid, status: 'SELECTED' };
    await this.bidRepository.save(updatedWinningBid);

    for (const bid of pendingBids) {
      if (bid.id !== winningBid.id) {
        await this.bidRepository.save({ ...bid, status: 'REJECTED' });
      }
    }

    logger.info(
      {
        taskId,
        executorPublicKey: winningBid.executorPublicKey,
        bidId: winningBid.id,
        amountStroops: winningBid.amountStroops,
      },
      '[Auction] task assigned to executor',
    );

    return { task: updatedTask, winningBid: updatedWinningBid };
  }
}
