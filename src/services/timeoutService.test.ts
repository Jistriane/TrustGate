import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { EscrowService } from './escrowService';
import { TimeoutService } from './timeoutService';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requester: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePrice: 1000,
    description: 'Do something useful',
    deadline: new Date(Date.now() - 1000).toISOString(),
    status: 'ASSIGNED',
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
    status: 'SELECTED',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFakeEscrowService() {
  return {
    confiscate: jest.fn().mockResolvedValue({
      success: true,
      disputeId: 'dispute-1',
      status: 'open',
      requesterShare: 35,
      marketplaceShare: 15,
    }),
  } as unknown as EscrowService;
}

describe('TimeoutService.runOnce', () => {
  it('confiscates collateral and marks an expired ASSIGNED task as EXPIRED', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask();
    taskRepository.save(task);
    const bid = makeBid();
    bidRepository.save(bid);

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([task.id]);
    expect(taskRepository.findById(task.id)?.status).toBe('EXPIRED');
    expect(escrowService.confiscate).toHaveBeenCalledWith(bid.escrowId, bid.collateral);
  });

  it('ignores tasks that are not ASSIGNED', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask({ status: 'OPEN' });
    taskRepository.save(task);

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    expect(taskRepository.findById(task.id)?.status).toBe('OPEN');
    expect(escrowService.confiscate).not.toHaveBeenCalled();
  });

  it('ignores ASSIGNED tasks whose deadline has not passed yet', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask({ deadline: new Date(Date.now() + 86400000).toISOString() });
    taskRepository.save(task);
    bidRepository.save(makeBid());

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    expect(taskRepository.findById(task.id)?.status).toBe('ASSIGNED');
  });

  it('skips a task with no selected bid without marking it expired', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask();
    taskRepository.save(task);

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    expect(taskRepository.findById(task.id)?.status).toBe('ASSIGNED');
    expect(escrowService.confiscate).not.toHaveBeenCalled();
  });

  it('leaves the task ASSIGNED when confiscation fails, so it can be retried', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = {
      confiscate: jest.fn().mockRejectedValue(new Error('escrow API unavailable')),
    } as unknown as EscrowService;

    const task = makeTask();
    taskRepository.save(task);
    bidRepository.save(makeBid());

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    expect(taskRepository.findById(task.id)?.status).toBe('ASSIGNED');
  });
});
