export type TaskStatus = 'OPEN' | 'ASSIGNED' | 'COMPLETING' | 'COMPLETED' | 'EXPIRED';

export interface Task {
  id: string;
  requesterPublicKey: string;
  reservePriceStroops: bigint;
  description: string;
  deadline: string;
  status: TaskStatus;
}
