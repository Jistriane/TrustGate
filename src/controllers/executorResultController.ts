import { Request, Response } from 'express';
import { ExecutorResultService } from '../services/executorResultService';

export class ExecutorResultController {
  constructor(private readonly resultService: ExecutorResultService) {}

  getResult = (req: Request, res: Response): void => {
    const taskId = String(req.params.taskId);
    res.status(200).json(this.resultService.getResult(taskId));
  };
}
