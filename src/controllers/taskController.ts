import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import {
  completeTaskRequestSchema,
  createTaskSchema,
  createTaskLocalRequestSchema,
} from '../models/taskSchema';
import { Task } from '../models/task';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { InsufficientBalanceError, MppChargeServiceLike } from '../services/mppChargeService';
import { TaskFeedService } from '../services/taskFeedService';
import { EscrowServiceLike } from '../services/escrowService';
import {
  AuctionService,
  NoBidsError,
  TaskNotFoundError,
  TaskNotOpenError,
} from '../services/auctionService';

export class TaskController {
  constructor(
    private readonly mppChargeService: MppChargeServiceLike,
    private readonly taskRepository: TaskRepository,
    private readonly taskFeedService: TaskFeedService,
    private readonly auctionService: AuctionService,
    private readonly escrowService: EscrowServiceLike,
    private readonly bidRepository: BidRepository,
  ) {}

  private async saveAndPublish(
    requester: string,
    reservePrice: number,
    description: string,
    deadline: string,
  ): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      requester,
      reservePrice,
      description,
      deadline,
      status: 'OPEN',
    };
    this.taskRepository.save(task);

    try {
      await this.taskFeedService.publishTask(task);
    } catch (err) {
      console.error('Failed to publish task to the feed:', err);
    }

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
      await this.mppChargeService.chargeListingFee(requesterKeypair, reservePrice);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        res.status(402).json({ error: 'payment required', detail: err.message });
        return;
      }
      res.status(502).json({ error: 'listing fee charge failed', detail: (err as Error).message });
      return;
    }

    const task = await this.saveAndPublish(requester, reservePrice, description, deadline);
    res.status(201).json(task);
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
    res.status(201).json(task);
  };

  select = (req: Request, res: Response): void => {
    const taskId = String(req.params.id);

    try {
      const { task, winningBid } = this.auctionService.selectWinner(taskId);
      res.status(200).json({ task, winningBid });
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

    const parsed = completeTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
      return;
    }

    const { requester, secret } = parsed.data;

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

    const task = this.taskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (task.requester !== requester) {
      res.status(403).json({ error: 'only the task requester can complete this task' });
      return;
    }

    if (task.status !== 'ASSIGNED') {
      res.status(409).json({ error: `task is not assigned (status: ${task.status})` });
      return;
    }

    const winningBid = this.bidRepository
      .findByTaskId(taskId)
      .find((bid) => bid.status === 'SELECTED');
    if (!winningBid) {
      res.status(409).json({ error: 'no selected bid found for this task' });
      return;
    }

    try {
      const release = await this.escrowService.releaseMilestone(winningBid.escrowId);

      const updatedTask: Task = { ...task, status: 'COMPLETED' };
      this.taskRepository.save(updatedTask);

      console.log(
        `[Escrow] milestone released for task ${taskId} — escrow ${winningBid.escrowId}, ` +
          `tx ${release.transactionHash}, ${release.amountReleased} to ${release.receiver}`,
      );

      res.status(200).json({ task: updatedTask, release });
    } catch (err) {
      res.status(502).json({ error: 'escrow release failed', detail: (err as Error).message });
    }
  };
}
