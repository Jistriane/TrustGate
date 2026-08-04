export type TaskStatus = 'OPEN' | 'ASSIGNED' | 'COMPLETED' | 'EXPIRED';

export interface Task {
  id: string;
  requester: string;
  reservePrice: number;
  description: string;
  deadline: string;
  status: TaskStatus;
}
