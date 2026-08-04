import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';

export class TaskNotFoundError extends Error {}
export class TaskNotOpenError extends Error {}
export class NoBidsError extends Error {}

export interface SelectWinnerResult {
  task: Task;
  winningBid: Bid;
}

export class AuctionService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly bidRepository: BidRepository,
  ) {}

  selectWinner(taskId: string): SelectWinnerResult {
    const task = this.taskRepository.findById(taskId);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${taskId}`);
    }
    if (task.status !== 'OPEN') {
      throw new TaskNotOpenError(task.status);
    }

    const pendingBids = this.bidRepository
      .findByTaskId(taskId)
      .filter((bid) => bid.status === 'PENDING');
    if (pendingBids.length === 0) {
      throw new NoBidsError(`No pending bids for task: ${taskId}`);
    }

    const winningBid = pendingBids.reduce((lowest, bid) => {
      if (bid.amount < lowest.amount) return bid;
      if (bid.amount === lowest.amount && bid.createdAt < lowest.createdAt) return bid;
      return lowest;
    });

    const updatedTask: Task = { ...task, status: 'ASSIGNED' };
    this.taskRepository.save(updatedTask);

    const updatedWinningBid: Bid = { ...winningBid, status: 'SELECTED' };
    this.bidRepository.save(updatedWinningBid);

    for (const bid of pendingBids) {
      if (bid.id !== winningBid.id) {
        this.bidRepository.save({ ...bid, status: 'REJECTED' });
      }
    }

    console.log(
      `[Auction] task ${taskId} assigned to executor ${winningBid.executor} (bid ${winningBid.id}, amount ${winningBid.amount})`,
    );

    return { task: updatedTask, winningBid: updatedWinningBid };
  }
}
