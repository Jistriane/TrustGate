import { Bid } from '../models/bid';

export class BidRepository {
  private readonly bids = new Map<string, Bid>();

  save(bid: Bid): void {
    this.bids.set(bid.id, bid);
  }

  findById(id: string): Bid | undefined {
    return this.bids.get(id);
  }

  findByTaskId(taskId: string): Bid[] {
    return this.list().filter((bid) => bid.taskId === taskId);
  }

  list(): Bid[] {
    return Array.from(this.bids.values());
  }
}
