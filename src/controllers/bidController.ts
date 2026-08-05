import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { createBidLocalSchema, createBidSignedSchema } from '../models/bidSchema';
import { Bid } from '../models/bid';
import { TaskRepositoryLike } from '../repositories/taskRepository';
import { BidRepositoryLike } from '../repositories/bidRepository';
import { IProviderEscrow } from '../services/escrowService';
import { ExecutorNotAllowedError, PolicyService } from '../services/policyService';
import { parseUsdcDecimalToStroops } from '../utils/money';
import { toBidDto } from '../presenters/bidPresenter';
import { OutboxService } from '../services/outboxService';
import { SafetyFeatures, loadSafetyFeatures } from '../config/safetyFeatures';
import { logger } from '../config/logger';

export class BidController {
  private readonly safety: SafetyFeatures;

  constructor(
    private readonly taskRepository: TaskRepositoryLike,
    private readonly escrowService: IProviderEscrow,
    private readonly bidRepository: BidRepositoryLike,
    private readonly policyService: PolicyService,
    private readonly outbox?: OutboxService,
    safetyFeatures?: SafetyFeatures,
  ) {
    this.safety = safetyFeatures ?? loadSafetyFeatures();
  }

  create = async (req: Request, res: Response): Promise<void> => {
    if (this.safety.pauseNewBids) {
      res.status(503).json({
        error: 'new bids are paused',
        detail: 'Marketplace operators have temporarily disabled new bids. Retry later or check status page.',
      });
      return;
    }

    let taskId: string;
    let executor: string;
    let amount: string;
    let collateral: string;
    let executorKeypair: Keypair | undefined;

    if (process.env.NETWORK === 'local') {
      const parsed = createBidLocalSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
        return;
      }
      ({ taskId, executor, amount, collateral } = parsed.data);

      try {
        executorKeypair = Keypair.fromSecret(parsed.data.secret);
      } catch {
        res.status(400).json({ error: 'invalid secret' });
        return;
      }

      if (executorKeypair.publicKey() !== executor) {
        res.status(400).json({ error: 'secret does not match executor' });
        return;
      }
    } else {
      const parsed = createBidSignedSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
        return;
      }
      ({ taskId, executor, amount, collateral } = parsed.data);
    }

    if (this.safety.executorDenylist.has(executor)) {
      logger.warn(
        { executorPublicKey: executor, taskId, reason: 'denylist_hit', endpoint: 'POST /bids' },
        'Denylist blocked bid from executor',
      );
      res.status(403).json({ error: 'executor is not allowed to bid' });
      return;
    }

    const task = await this.taskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    if (task.status !== 'OPEN') {
      res.status(409).json({ error: `task is not open for bids (status: ${task.status})` });
      return;
    }

    // Enforce the on-chain Registry allow-list before locking collateral.
    // Only registered executors are permitted to bid.
    try {
      await this.policyService.authorizeExecutorPayment(executor);
    } catch (err) {
      if (err instanceof ExecutorNotAllowedError) {
        res.status(403).json({ error: 'executor is not registered' });
        return;
      }
      res.status(500).json({ error: 'executor authorization failed', detail: (err as Error).message });
      return;
    }

    let escrowId: string;
    try {
      escrowId = await this.escrowService.createEscrow(executor, taskId, Number(collateral));
    } catch (err) {
      res.status(502).json({ error: 'escrow creation failed', detail: (err as Error).message });
      return;
    }

    let amountStroops: bigint;
    let collateralStroops: bigint;
    try {
      amountStroops = parseUsdcDecimalToStroops(amount);
      collateralStroops = parseUsdcDecimalToStroops(collateral);
    } catch (err) {
      res.status(400).json({ error: 'invalid amount/collateral', detail: (err as Error).message });
      return;
    }

    const bid: Bid = {
      id: randomUUID(),
      taskId,
      executorPublicKey: executor,
      amountStroops,
      collateralStroops,
      escrowId,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };
    await this.bidRepository.save(bid);

    await this.outbox?.emit({
      type: 'bid_placed',
      aggregateType: 'bid',
      aggregateId: bid.id,
      payload: toBidDto(bid),
    });

    res.status(201).json(toBidDto(bid));
  };
}
