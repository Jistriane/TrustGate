import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createBidSchema } from '../models/bidSchema';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { EscrowServiceLike } from '../services/escrowService';

export class BidController {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly escrowService: EscrowServiceLike,
    private readonly bidRepository: BidRepository,
  ) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const parsed = createBidSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
      return;
    }

    const { taskId, executor, secret, amount, collateral } = parsed.data;

    let executorKeypair: Keypair;
    try {
      executorKeypair = Keypair.fromSecret(secret);
    } catch {
      res.status(400).json({ error: 'invalid secret' });
      return;
    }

    if (executorKeypair.publicKey() !== executor) {
      res.status(400).json({ error: 'secret does not match executor' });
      return;
    }

    const task = this.taskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (task.status !== 'OPEN') {
      res.status(409).json({ error: `task is not open for bids (status: ${task.status})` });
      return;
    }

    let escrowId: string;
    try {
      escrowId = await this.escrowService.createEscrow(executorKeypair, taskId, collateral);
    } catch (err) {
      res.status(502).json({ error: 'escrow creation failed', detail: (err as Error).message });
      return;
    }

    const bid: Bid = {
      id: randomUUID(),
      taskId,
      executor,
      amount,
      collateral,
      escrowId,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    this.bidRepository.save(bid);

    res.status(201).json(bid);
  };
}
