import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { AuctionService, NoBidsError, TaskNotFoundError, TaskNotOpenError } from './auctionService';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requester: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePrice: 1000,
    description: 'Do something useful',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    status: 'OPEN',
    ...overrides,
  };
}

function makeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 'bid-1',
    taskId: 'task-1',
    executor: 'GBEXECUTOR000000000000000000000000000000000000000000000',
    amount: 500,
    collateral: 50,
    escrowId: 'CESCROW00000000000000000000000000000000000000000000000',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AuctionService.selectWinner', () => {
  function setup() {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const auctionService = new AuctionService(taskRepository, bidRepository);
    return { taskRepository, bidRepository, auctionService };
  }

  it('selects the lowest bid, assigns the task, and rejects the others', () => {
    const { taskRepository, bidRepository, auctionService } = setup();
    const task = makeTask();
    taskRepository.save(task);

    const lowBid = makeBid({ id: 'bid-low', amount: 400 });
    const highBid = makeBid({ id: 'bid-high', amount: 700 });
    bidRepository.save(highBid);
    bidRepository.save(lowBid);

    const result = auctionService.selectWinner(task.id);

    expect(result.task.status).toBe('ASSIGNED');
    expect(result.winningBid.id).toBe('bid-low');
    expect(result.winningBid.status).toBe('SELECTED');

    expect(taskRepository.findById(task.id)?.status).toBe('ASSIGNED');
    expect(bidRepository.findById('bid-low')?.status).toBe('SELECTED');
    expect(bidRepository.findById('bid-high')?.status).toBe('REJECTED');
  });

  it('breaks ties by earliest createdAt', () => {
    const { taskRepository, bidRepository, auctionService } = setup();
    const task = makeTask();
    taskRepository.save(task);

    const earlier = makeBid({
      id: 'bid-earlier',
      amount: 500,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    });
    const later = makeBid({ id: 'bid-later', amount: 500, createdAt: new Date().toISOString() });
    bidRepository.save(later);
    bidRepository.save(earlier);

    const result = auctionService.selectWinner(task.id);

    expect(result.winningBid.id).toBe('bid-earlier');
  });

  it('throws TaskNotFoundError for an unknown task', () => {
    const { auctionService } = setup();
    expect(() => auctionService.selectWinner('missing')).toThrow(TaskNotFoundError);
  });

  it('throws TaskNotOpenError when the task is not OPEN', () => {
    const { taskRepository, auctionService } = setup();
    const task = makeTask({ status: 'ASSIGNED' });
    taskRepository.save(task);

    expect(() => auctionService.selectWinner(task.id)).toThrow(TaskNotOpenError);
  });

  it('throws NoBidsError when there are no pending bids', () => {
    const { taskRepository, auctionService } = setup();
    const task = makeTask();
    taskRepository.save(task);

    expect(() => auctionService.selectWinner(task.id)).toThrow(NoBidsError);
  });

  it('ignores non-pending bids when selecting', () => {
    const { taskRepository, bidRepository, auctionService } = setup();
    const task = makeTask();
    taskRepository.save(task);

    const rejected = makeBid({ id: 'bid-rejected', amount: 100, status: 'REJECTED' });
    const pending = makeBid({ id: 'bid-pending', amount: 600 });
    bidRepository.save(rejected);
    bidRepository.save(pending);

    const result = auctionService.selectWinner(task.id);

    expect(result.winningBid.id).toBe('bid-pending');
  });
});
