import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { AuctionService, NoBidsError, TaskNotFoundError, TaskNotOpenError } from './auctionService';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requesterPublicKey: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePriceStroops: 10000000000n,
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
    executorPublicKey: 'GBEXECUTOR000000000000000000000000000000000000000000000',
    amountStroops: 5000000000n,
    collateralStroops: 500000000n,
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

  it('selects the lowest bid, assigns the task, and rejects the others', async () => {
    const { taskRepository, bidRepository, auctionService } = setup();
    const task = makeTask();
    await taskRepository.save(task);

    const lowBid = makeBid({ id: 'bid-low', amountStroops: 4000000000n });
    const highBid = makeBid({ id: 'bid-high', amountStroops: 7000000000n });
    await bidRepository.save(highBid);
    await bidRepository.save(lowBid);

    const result = await auctionService.selectWinner(task.id);

    expect(result.task.status).toBe('ASSIGNED');
    expect(result.winningBid.id).toBe('bid-low');
    expect(result.winningBid.status).toBe('SELECTED');

    await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'ASSIGNED' });
    await expect(bidRepository.findById('bid-low')).resolves.toMatchObject({ status: 'SELECTED' });
    await expect(bidRepository.findById('bid-high')).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('breaks ties by earliest createdAt', async () => {
    const { taskRepository, bidRepository, auctionService } = setup();
    const task = makeTask();
    await taskRepository.save(task);

    const earlier = makeBid({
      id: 'bid-earlier',
      amountStroops: 5000000000n,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    });
    const later = makeBid({ id: 'bid-later', amountStroops: 5000000000n, createdAt: new Date().toISOString() });
    await bidRepository.save(later);
    await bidRepository.save(earlier);

    const result = await auctionService.selectWinner(task.id);

    expect(result.winningBid.id).toBe('bid-earlier');
  });

  it('throws TaskNotFoundError for an unknown task', async () => {
    const { auctionService } = setup();
    await expect(auctionService.selectWinner('missing')).rejects.toThrow(TaskNotFoundError);
  });

  it('throws TaskNotOpenError when the task is not OPEN', async () => {
    const { taskRepository, auctionService } = setup();
    const task = makeTask({ status: 'ASSIGNED' });
    await taskRepository.save(task);

    await expect(auctionService.selectWinner(task.id)).rejects.toThrow(TaskNotOpenError);
  });

  it('throws NoBidsError when there are no pending bids', async () => {
    const { taskRepository, auctionService } = setup();
    const task = makeTask();
    await taskRepository.save(task);

    await expect(auctionService.selectWinner(task.id)).rejects.toThrow(NoBidsError);
  });

  it('ignores non-pending bids when selecting', async () => {
    const { taskRepository, bidRepository, auctionService } = setup();
    const task = makeTask();
    await taskRepository.save(task);

    const rejected = makeBid({ id: 'bid-rejected', amountStroops: 1000000000n, status: 'REJECTED' });
    const pending = makeBid({ id: 'bid-pending', amountStroops: 6000000000n });
    await bidRepository.save(rejected);
    await bidRepository.save(pending);

    const result = await auctionService.selectWinner(task.id);

    expect(result.winningBid.id).toBe('bid-pending');
  });
});
