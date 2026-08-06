import { BidRepository } from './bidRepository';
import { Bid } from '../models/bid';

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

describe('BidRepository (InMemoryBidRepository)', () => {
  it('saves and finds a bid by id', async () => {
    const repo = new BidRepository();
    const bid = makeBid();
    await repo.save(bid);
    await expect(repo.findById(bid.id)).resolves.toEqual(bid);
  });

  it('findByTaskId returns correct bids for the task', async () => {
    const repo = new BidRepository();
    const bT1a = makeBid({ id: 'b1a', taskId: 'task-1' });
    const bT1b = makeBid({ id: 'b1b', taskId: 'task-1' });
    const bT2 = makeBid({ id: 'b2', taskId: 'task-2' });
    await repo.save(bT1a);
    await repo.save(bT1b);
    await repo.save(bT2);
    const r = await repo.findByTaskId('task-1');
    expect(r.map((b) => b.id).sort()).toEqual(['b1a', 'b1b'].sort());
  });

  it('listSelectedCreatedBefore filters only SELECTED with createdAt <= cutoff', async () => {
    const repo = new BidRepository();
    const veryOld = Date.now() - 20 * 86400 * 1000;
    const recent = Date.now() - 1000;
    const selectedOld = makeBid({ id: 'sel-old', status: 'SELECTED', createdAt: new Date(veryOld).toISOString() });
    const selectedRecent = makeBid({ id: 'sel-rec', status: 'SELECTED', createdAt: new Date(recent).toISOString() });
    const rejectedOld = makeBid({ id: 'rej-old', status: 'REJECTED', createdAt: new Date(veryOld).toISOString() });
    await repo.save(selectedOld);
    await repo.save(selectedRecent);
    await repo.save(rejectedOld);
    const cutoff = Date.now() - 14 * 86400 * 1000;
    const result = await repo.listSelectedCreatedBefore(new Date(cutoff).toISOString());
    expect(result.map((b) => b.id)).toEqual(['sel-old']);
  });

  it('listSelectedCreatedBefore accepts Date and ISO string', async () => {
    const repo = new BidRepository();
    const old = Date.now() - 15 * 86400 * 1000;
    const b = makeBid({ id: 'b1', status: 'SELECTED', createdAt: new Date(old).toISOString() });
    await repo.save(b);
    const viaDate = await repo.listSelectedCreatedBefore(new Date());
    const viaIso = await repo.listSelectedCreatedBefore(new Date().toISOString());
    expect(viaDate).toHaveLength(1);
    expect(viaIso).toHaveLength(1);
  });

  it('findById returns undefined when it does not exist', async () => {
    const repo = new BidRepository();
    await expect(repo.findById('missing-xxx')).resolves.toBeUndefined();
  });
});
