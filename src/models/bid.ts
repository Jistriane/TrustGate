export type BidStatus = 'PENDING' | 'SELECTED' | 'REJECTED';

export interface Bid {
  id: string;
  taskId: string;
  executor: string;
  amount: number;
  collateral: number;
  escrowId: string;
  status: BidStatus;
  createdAt: string;
}
