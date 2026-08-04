import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import {
  completeTaskLocalRequestSchema,
  completeTaskSignedRequestSchema,
  createTaskSchema,
  createTaskLocalRequestSchema,
} from '../models/taskSchema';
import { Task } from '../models/task';
import { TaskRepositoryLike } from '../repositories/taskRepository';
import { BidRepositoryLike } from '../repositories/bidRepository';
import { InsufficientBalanceError, MppChargeServiceLike } from '../services/mppChargeService';
import { TaskFeedService } from '../services/taskFeedService';
import { EscrowServiceLike } from '../services/escrowService';
import {
  AuctionService,
  NoBidsError,
  TaskNotFoundError,
  TaskNotOpenError,
} from '../services/auctionService';
import { parseUsdcDecimalToStroops } from '../utils/money';
import { toTaskDto } from '../presenters/taskPresenter';
import { toBidDto } from '../presenters/bidPresenter';
import { OutboxService } from '../services/outboxService';

export class TaskController {
  constructor(
    private readonly mppChargeService: MppChargeServiceLike,
    private readonly taskRepository: TaskRepositoryLike,
    private readonly taskFeedService: TaskFeedService,
    private readonly auctionService: AuctionService,
    private readonly escrowService: EscrowServiceLike,
    private readonly bidRepository: BidRepositoryLike,
    private readonly outbox?: OutboxService,
  ) {}

  private async saveAndPublish(
    requesterPublicKey: string,
    reservePrice: string,
    description: string,
    deadline: string,
  ): Promise<Task> {
    const reservePriceStroops = parseUsdcDecimalToStroops(reservePrice);
    const task: Task = {
      id: randomUUID(),
      requesterPublicKey,
      reservePriceStroops,
      description,
      deadline,
      status: 'OPEN',
    };
    await this.taskRepository.save(task);

    try {
      await this.taskFeedService.publishTask(task);
    } catch (err) {
      console.error('Failed to publish task to the feed:', err);
    }

    await this.outbox?.emit({
      type: 'task_created',
      aggregateType: 'task',
      aggregateId: task.id,
      payload: toTaskDto(task),
    });

    return task;
  }

  /**
   * `NETWORK=local` dev/CI-only path: the requester's secret is sent
   * directly and this server signs the listing-fee transfer itself. See
   * `createPaid` for the real MPP Charge protocol path used on testnet/pubnet.
   */
  create = async (req: Request, res: Response): Promise<void> => {
    const parsed = createTaskLocalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
      return;
    }

    const { requester, reservePrice, description, deadline, secret } = parsed.data;
    let reservePriceStroops: bigint;
    try {
      reservePriceStroops = parseUsdcDecimalToStroops(reservePrice);
    } catch (err) {
      res.status(400).json({ error: 'invalid reservePrice', detail: (err as Error).message });
      return;
    }

    let requesterKeypair: Keypair;
    try {
      requesterKeypair = Keypair.fromSecret(secret);
    } catch {
      res.status(400).json({ error: 'invalid secret' });
      return;
    }

    if (requesterKeypair.publicKey() !== requester) {
      res.status(400).json({ error: 'secret does not match requester' });
      return;
    }

    try {
      await this.mppChargeService.chargeListingFee(requesterKeypair, reservePriceStroops);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({ error: 'payment required', detail: err.message });
        return;
      }
      res.status(502).json({ error: 'listing fee charge failed', detail: (err as Error).message });
      return;
    }

    const task = await this.saveAndPublish(requester, reservePrice, description, deadline);
    res.status(201).json(toTaskDto(task));
  };

  /**
   * testnet/pubnet path: mounted behind the real MPP Charge gate (see
   * `src/config/mppCharge.ts` and its wiring in `app.ts`), which has already
   * verified and settled the listing fee by the time this handler runs. No
   * secret is ever sent by the client.
   */
  createPaid = async (req: Request, res: Response): Promise<void> => {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
      return;
    }

    const { requester, reservePrice, description, deadline } = parsed.data;
    const task = await this.saveAndPublish(requester, reservePrice, description, deadline);
    res.status(201).json(toTaskDto(task));
  };

  select = async (req: Request, res: Response): Promise<void> => {
    const taskId = String(req.params.id);

    try {
      const { task, winningBid } = await this.auctionService.selectWinner(taskId);
      await this.outbox?.emit({
        type: 'task_assigned',
        aggregateType: 'task',
        aggregateId: task.id,
        payload: { task: toTaskDto(task), winningBid: toBidDto(winningBid) },
      });
      res.status(200).json({ task: toTaskDto(task), winningBid: toBidDto(winningBid) });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      if (err instanceof TaskNotOpenError) {
        res.status(409).json({ error: `task is not open for selection (status: ${err.message})` });
        return;
      }
      if (err instanceof NoBidsError) {
        res.status(409).json({ error: 'no pending bids for this task' });
        return;
      }
      res.status(500).json({ error: 'failed to select winner', detail: (err as Error).message });
    }
  };

  complete = async (req: Request, res: Response): Promise<void> => {
    const taskId = String(req.params.id);

    let requester: string;
    if (process.env.NETWORK === 'local') {
      const parsed = completeTaskLocalRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
        return;
      }
      requester = parsed.data.requester;
      const secret = parsed.data.secret;
      let requesterKeypair: Keypair;
      try {
        requesterKeypair = Keypair.fromSecret(secret);
      } catch {
        res.status(400).json({ error: 'invalid secret' });
        return;
      }

      if (requesterKeypair.publicKey() !== requester) {
        res.status(400).json({ error: 'secret does not match requester' });
        return;
      }
    } else {
      const parsed = completeTaskSignedRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
        return;
      }
      requester = parsed.data.requester;
    }

    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (task.requesterPublicKey !== requester) {
      res.status(403).json({ error: 'only the task requester can complete this task' });
      return;
    }

    if (task.status === 'COMPLETED') {
      res.status(200).json({ task: toTaskDto(task), status: 'already completed' });
      return;
    }

    if (task.status === 'COMPLETING') {
      res.status(202).json({ task: toTaskDto(task), status: 'completion in progress' });
      return;
    }

    if (task.status !== 'ASSIGNED') {
      res.status(409).json({ error: `task is not assigned (status: ${task.status})` });
      return;
    }

    const winningBid = (await this.bidRepository.findByTaskId(taskId)).find(
      (bid) => bid.status === 'SELECTED',
    );
    if (!winningBid) {
      res.status(409).json({ error: 'no selected bid found for this task' });
      return;
    }

    if (!this.outbox) {
      try {
        const release = await this.escrowService.releaseMilestone(winningBid.escrowId);
        const updatedTask: Task = { ...task, status: 'COMPLETED' };
        await this.taskRepository.save(updatedTask);
        res.status(200).json({ task: toTaskDto(updatedTask), release });
      } catch (err) {
        res.status(502).json({ error: 'escrow release failed', detail: (err as Error).message });
      }
      return;
    }

    const completingTask: Task = { ...task, status: 'COMPLETING' };
    await this.taskRepository.save(completingTask);
    await this.outbox.emit({
      type: 'task_completion_requested',
      aggregateType: 'task',
      aggregateId: completingTask.id,
      payload: { taskId: completingTask.id, escrowId: winningBid.escrowId },
    });
    res.status(202).json({ task: toTaskDto(completingTask) });
  };
}
