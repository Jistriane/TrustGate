import { Bid } from '../models/bid';
import { formatUsdcStroopsToDecimal } from '../utils/money';

export interface BidDto {
  id: string;
  taskId: string;
  executorPublicKey: string;
  amount: string;
  amountStroops: string;
  collateral: string;
  collateralStroops: string;
  escrowId: string;
  status: Bid['status'];
  createdAt: string;
}

export function toBidDto(bid: Bid): BidDto {
  return {
    id: bid.id,
    taskId: bid.taskId,
    executorPublicKey: bid.executorPublicKey,
    amount: formatUsdcStroopsToDecimal(bid.amountStroops),
    amountStroops: bid.amountStroops.toString(),
    collateral: formatUsdcStroopsToDecimal(bid.collateralStroops),
    collateralStroops: bid.collateralStroops.toString(),
    escrowId: bid.escrowId,
    status: bid.status,
    createdAt: bid.createdAt,
  };
}

