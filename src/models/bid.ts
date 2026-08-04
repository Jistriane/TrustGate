export type BidStatus = 'PENDING' | 'SELECTED' | 'REJECTED';

export interface Bid {
  id: string;
  taskId: string;
  executorPublicKey: string;
  amountStroops: bigint;
  collateralStroops: bigint;
  escrowId: string;
  status: BidStatus;
  createdAt: string;
}
