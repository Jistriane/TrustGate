import { Task } from '../models/task';
import { formatUsdcStroopsToDecimal } from '../utils/money';

export interface TaskDto {
  id: string;
  requesterPublicKey: string;
  reservePrice: string;
  reservePriceStroops: string;
  description: string;
  deadline: string;
  status: Task['status'];
}

export function toTaskDto(task: Task): TaskDto {
  return {
    id: task.id,
    requesterPublicKey: task.requesterPublicKey,
    reservePrice: formatUsdcStroopsToDecimal(task.reservePriceStroops),
    reservePriceStroops: task.reservePriceStroops.toString(),
    description: task.description,
    deadline: task.deadline,
    status: task.status,
  };
}

