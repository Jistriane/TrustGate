import { Request, Response } from 'express';
import { BidRepositoryLike } from '../repositories/bidRepository';
import { TaskRepositoryLike } from '../repositories/taskRepository';
import { ExecutorResultService } from '../services/executorResultService';
import { OutboxService } from '../services/outboxService';

export class ExecutorResultController {
  constructor(
    private readonly resultService: ExecutorResultService,
    private readonly taskRepository: TaskRepositoryLike,
    private readonly bidRepository: BidRepositoryLike,
    private readonly outbox?: OutboxService,
  ) {}

  getResult = async (req: Request, res: Response): Promise<void> => {
    const taskId = String(req.params.taskId);
    const task = await this.taskRepository.findById(taskId);

    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (!['ASSIGNED', 'COMPLETING', 'COMPLETED'].includes(task.status)) {
      res.status(409).json({ error: 'task result is not available until the task is assigned' });
      return;
    }

    const selectedBid = (await this.bidRepository.findByTaskId(taskId)).find(
      (bid) => bid.status === 'SELECTED',
    );

    if (!selectedBid) {
      res.status(409).json({ error: 'no selected executor for this task' });
      return;
    }

    const result = await this.resultService.get(taskId);
    if (!result) {
      res.status(404).json({ error: 'result not found' });
      return;
    }

    res.status(200).json({ taskId: result.taskId, payloadHash: result.payloadHash, payload: result.payload });
  };

  publishResult = async (req: Request, res: Response): Promise<void> => {
    const taskId = String(req.params.taskId);
    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (task.status !== 'ASSIGNED') {
      res.status(409).json({ error: 'task is not assigned' });
      return;
    }

    const selectedBid = (await this.bidRepository.findByTaskId(taskId)).find(
      (bid) => bid.status === 'SELECTED',
    );

    if (!selectedBid) {
      res.status(409).json({ error: 'no selected executor for this task' });
      return;
    }

    const executorPublicKey = (req.body ?? {}).executorPublicKey;
    if (typeof executorPublicKey !== 'string') {
      res.status(400).json({ error: 'executorPublicKey is required' });
      return;
    }

    if (executorPublicKey !== selectedBid.executorPublicKey) {
      res.status(403).json({ error: 'only the selected executor can publish a result' });
      return;
    }

    const payload = (req.body ?? {}).payload;
    if (payload === undefined) {
      res.status(400).json({ error: 'payload is required' });
      return;
    }

    const stored = await this.resultService.publish(taskId, payload);
    await this.outbox?.emit({
      type: 'result_published',
      aggregateType: 'task',
      aggregateId: taskId,
      payload: {
        taskId: stored.taskId,
        executorPublicKey,
        payloadHash: stored.payloadHash,
        publishedAt: stored.createdAt,
      },
    });
    res.status(201).json({ taskId: stored.taskId, payloadHash: stored.payloadHash });
  };
}
