import { Request, Response } from 'express';
import { BidRepository } from '../repositories/bidRepository';
import { TaskRepository } from '../repositories/taskRepository';
import { ExecutorResultService } from '../services/executorResultService';

export class ExecutorResultController {
  constructor(
    private readonly resultService: ExecutorResultService,
    private readonly taskRepository: TaskRepository,
    private readonly bidRepository: BidRepository,
  ) {}

  getResult = (req: Request, res: Response): void => {
    const taskId = String(req.params.taskId);
    const task = this.taskRepository.findById(taskId);

    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (!['ASSIGNED', 'COMPLETED'].includes(task.status)) {
      res.status(409).json({ error: 'task result is not available until the task is assigned' });
      return;
    }

    const selectedBid = this.bidRepository
      .findByTaskId(taskId)
      .find((bid) => bid.status === 'SELECTED');

    if (!selectedBid) {
      res.status(409).json({ error: 'no selected executor for this task' });
      return;
    }

    res.status(200).json(this.resultService.getResult(taskId));
  };
}
