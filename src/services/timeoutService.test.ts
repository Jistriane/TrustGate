import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { EscrowService } from './escrowService';
import { TimeoutService } from './timeoutService';

jest.mock('../config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requesterPublicKey: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePriceStroops: 10000000000n,
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
    executorPublicKey: 'GBEXECUTOR000000000000000000000000000000000000000000000',
    amountStroops: 5000000000n,
    collateralStroops: 500000000n,
    escrowId: 'CESCROW00000000000000000000000000000000000000000000000',
    status: 'SELECTED',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFakeEscrowService(overrides?: { claimTimeoutError?: Error | null }) {
  return {
    confiscate: jest.fn().mockResolvedValue({
      success: true,
      disputeId: 'dispute-1',
      status: 'open',
      requesterShare: 35,
      marketplaceShare: 15,
    }),
    claimTimeout: jest.fn().mockImplementation(async () => {
      if (overrides?.claimTimeoutError) {
        throw overrides.claimTimeoutError;
      }
      return {
        transactionHash: 'tx-claim-' + Math.random().toString(36).slice(2, 10),
        amountTransferred: 500000000n,
        beneficiary: 'GBEXECUTOR000000000000000000000000000000000000000000000',
      };
    }),
  } as unknown as EscrowService;
}

describe('TimeoutService.runOnce', () => {
  it('confiscates collateral and marks an expired ASSIGNED task as EXPIRED — uses listAssignedDeadlineBefore (scaling) NOT list()', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const taskListSpy = jest.spyOn(taskRepository, 'list');
    const taskQuerySpy = jest.spyOn(taskRepository, 'listAssignedDeadlineBefore');

    const task = makeTask();
    await taskRepository.save(task);
    const bid = makeBid();
    await bidRepository.save(bid);

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([task.id]);
    await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'EXPIRED' });
    expect(escrowService.confiscate).toHaveBeenCalledWith(bid.escrowId, 50);
    expect(taskListSpy).toHaveBeenCalledTimes(0);
    expect(taskQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('ignores tasks that are not ASSIGNED', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask({ status: 'OPEN' });
    await taskRepository.save(task);

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'OPEN' });
    expect(escrowService.confiscate).not.toHaveBeenCalled();
  });

  it('ignores ASSIGNED tasks whose deadline has not passed yet', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask({ deadline: new Date(Date.now() + 86400000).toISOString() });
    await taskRepository.save(task);
    await bidRepository.save(makeBid());

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'ASSIGNED' });
  });

  it('skips a task with no selected bid without marking it expired', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const task = makeTask();
    await taskRepository.save(task);

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'ASSIGNED' });
    expect(escrowService.confiscate).not.toHaveBeenCalled();
  });

  it('leaves the task ASSIGNED when confiscation fails, so it can be retried', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = {
      confiscate: jest.fn().mockRejectedValue(new Error('escrow API unavailable')),
    } as unknown as EscrowService;

    const task = makeTask();
    await taskRepository.save(task);
    await bidRepository.save(makeBid());

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService);
    const result = await timeoutService.runOnce();

    expect(result.expiredTaskIds).toEqual([]);
    await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'ASSIGNED' });
  });
});

describe('TimeoutService.runClaimTimeoutPass (executor collateral refund 14d)', () => {
  it('claims SELECTED bids with createdAt ≥ 14d old — uses listSelectedCreatedBefore (scaling) NOT bidRepository.list()', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowService = makeFakeEscrowService();

    const bidListSpy = jest.spyOn(bidRepository, 'list');
    const bidQuerySpy = jest.spyOn(bidRepository, 'listSelectedCreatedBefore');

    const task = makeTask({ status: 'COMPLETED' });
    await taskRepository.save(task);

    const OLD_15_DAYS_AGO = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const FRESH_NOW = new Date().toISOString();
    const bidOld = makeBid({ id: 'bid-old', escrowId: 'CE-OLD', createdAt: OLD_15_DAYS_AGO, status: 'SELECTED' });
    const bidFresh = makeBid({ id: 'bid-fresh', escrowId: 'CE-FRESH', createdAt: FRESH_NOW, status: 'SELECTED' });
    const bidRejected = makeBid({ id: 'bid-rej', escrowId: 'CE-REJECTED', createdAt: OLD_15_DAYS_AGO, status: 'REJECTED' });
    await bidRepository.save(bidOld);
    await bidRepository.save(bidFresh);
    await bidRepository.save(bidRejected);

    const outboxEmit = jest.fn().mockResolvedValue(undefined);
    const outbox = { emit: outboxEmit } as any;

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowService, outbox);
    const result = await timeoutService.runClaimTimeoutPass();

    expect(result.claimedEscrowIds).toEqual([bidOld.escrowId]);
    const ctMock = (escrowService as any).claimTimeout as jest.Mock;
    expect(ctMock).toHaveBeenCalledTimes(1);
    expect(ctMock).toHaveBeenCalledWith(bidOld.escrowId);

    expect(outboxEmit).toHaveBeenCalledTimes(1);
    expect(outboxEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'escrow_claim_timeout_executed',
        aggregateType: 'bid',
        aggregateId: bidOld.id,
      }),
    );
    expect(bidListSpy).toHaveBeenCalledTimes(0);
    expect(bidQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('treats on-chain ClaimTooEarly as debug/retry (skip this cycle), and hard errors as error log (also skip)', async () => {
    const taskRepository = new TaskRepository();
    const bidRepository = new BidRepository();
    const escrowGoodClaim = makeFakeEscrowService({ claimTimeoutError: new Error('ClaimTooEarly ledger 123 not yet ready') });
    const task = makeTask({ status: 'COMPLETING' });
    await taskRepository.save(task);
    const OLD = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await bidRepository.save(makeBid({ id: 'bid-edge', escrowId: 'CE-EDGE', createdAt: OLD }));

    const timeoutService = new TimeoutService(taskRepository, bidRepository, escrowGoodClaim);
    const r1 = await timeoutService.runClaimTimeoutPass();
    expect(r1.claimedEscrowIds).toEqual([]);

    const escrowHardErr = makeFakeEscrowService({ claimTimeoutError: new Error('RPC 500 internal server') });
    const timeoutService2 = new TimeoutService(taskRepository, bidRepository, escrowHardErr);
    const r2 = await timeoutService2.runClaimTimeoutPass();
    expect(r2.claimedEscrowIds).toEqual([]);
  });
});
