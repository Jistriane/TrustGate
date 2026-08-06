import cron, { ScheduledTask } from 'node-cron';
import { TaskRepositoryLike } from '../repositories/taskRepository';
import { BidRepositoryLike } from '../repositories/bidRepository';
import { IProviderEscrow } from './escrowService';
import { formatUsdcStroopsToDecimal } from '../utils/money';
import { OutboxService } from './outboxService';
import { logger } from '../config/logger';
import { tgClaimTimeoutAttemptsTotal } from '../config/workerMetrics';

export interface TimeoutRunResult {
  expiredTaskIds: string[];
}

export interface ClaimTimeoutRunResult {
  claimedEscrowIds: string[];
}

const CLAIM_TIMEOUT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * ## TimeoutService — 2 independent passes (dual cron architecture every 5min)
 *
 * ### Step 1: `runOnce()` — confiscation for abandonment (requester wins P0-7)
 *   Scalable query: `tasks WHERE status='ASSIGNED' AND deadline < NOW()`
 *   For each expired task → calls escrow.confiscate(); 70%/30% marketplace-requester split
 *   minimum requester 3000 bps = 30% (CONFISCATE_REQUESTER_MIN_BP on-chain).
 *
 * ### Step 2: `runClaimTimeoutPass()` — honest executor reward (executor wins P0-2/P0-6)
 *
 *   #### Documented heuristic trade-off (honest GAP / architectural decision):
 *   The on-chain contract validates EXACTLY:
 *     `state.created_at_ledger + 241920 (14d @5s/ledger) <= current_ledger && status == LOCKED`
 *
 *   To AVOID having to maintain an on-chain indexer (The Graph/Subgraph) reading
 *   `EscrowState.created_at_ledger` every cycle (expensive infra + maintenance), we use
 *   **conservative OFF-CHAIN heuristic**:
 *
 *      1. listSelectedCreatedBefore(NOW - 14d) → filters bids with old SQL ISO createdAt
 *         ≥ 14d. This is POSSIBLE FALSE POSITIVE (bid created 14d ago but the
 *         on-chain create_escrow transaction was only mined at ledger X later,
 *         i.e., ledger clock is "behind" the server wall-clock).
 *
 *      2. We call claim_timeout on-chain for all candidates.
 *         If ledger has not arrived yet → contract returns **ClaimTooEarly=10**.
 *         We handle it as logger.debug (not an error) + retry on the next tick
 *         5-minute cron.
 *
 *   Heuristic result: NEVER claims early (safe). In the worst case, claims
 *   ~5min late (one tick behind). Cost: 1 extra RPC attempt per bid around
 *   the 14d cutoff; expected ClaimTooEarly rate < 5% on average
 *   (escrow creation typically occurs <1s after bid.createdAt in most flows).
 *
 *   4 Questions validated here:
 *   (1) Business: Honest executor does not lose collateral due to signer inactivity.
 *   (2) Constraints: No operation is done on-chain without real contract validation.
 *   (3) Quality: Automatic ClaimTooEarly retry → no false Sentry alerts.
 *   (4) Alternative: Real indexer (e.g., The Graph) cost ~US$300/month minimum +
 *       new failure point; cost justification does not exist for current volume.
 *
 *   When to migrate to indexer: When > 500 claims/day or ClaimTooEarly > 20%.
 */
export class TimeoutService {
  constructor(
    private readonly taskRepository: TaskRepositoryLike,
    private readonly bidRepository: BidRepositoryLike,
    private readonly escrowService: IProviderEscrow,
    private readonly outbox?: OutboxService,
  ) {}

  async runOnce(): Promise<TimeoutRunResult> {
    const now = Date.now();
    const expiredTaskIds: string[] = [];

    const expiredAssignedTasks = await this.taskRepository.listAssignedDeadlineBefore(new Date(now).toISOString());

    for (const task of expiredAssignedTasks) {
      const winningBid = (await this.bidRepository.findByTaskId(task.id)).find(
        (bid) => bid.status === 'SELECTED',
      );

      if (!winningBid) {
        logger.warn({ taskId: task.id }, '[Timeout] task expired but has no selected bid — skipping');
        continue;
      }

      try {
        const collateralAmount = Number(formatUsdcStroopsToDecimal(winningBid.collateralStroops));
        const result = await this.escrowService.confiscate(winningBid.escrowId, collateralAmount);
        logger.info(
          {
            taskId: task.id,
            escrowId: winningBid.escrowId,
            requesterShare: result.requesterShare,
            marketplaceShare: result.marketplaceShare,
            disputeId: result.disputeId,
          },
          '[Timeout] task expired — confiscated escrow',
        );
      } catch (err) {
        logger.error({ err, taskId: task.id }, '[Timeout] failed to confiscate collateral');
        continue;
      }

      const updatedTask = { ...task, status: 'EXPIRED' as const };
      await this.taskRepository.save(updatedTask);
      await this.outbox?.emit({
        type: 'task_expired',
        aggregateType: 'task',
        aggregateId: updatedTask.id,
        payload: { taskId: updatedTask.id },
      });
      expiredTaskIds.push(task.id);
    }

    return { expiredTaskIds };
  }

  async runClaimTimeoutPass(ageCutoffMs: number = CLAIM_TIMEOUT_AGE_MS): Promise<ClaimTimeoutRunResult> {
    const now = Date.now();
    const claimedEscrowIds: string[] = [];

    const createdAtCutoff = new Date(now - ageCutoffMs).toISOString();
    const candidateBids = await this.bidRepository.listSelectedCreatedBefore(createdAtCutoff);

    logger.info(
      { candidateCount: candidateBids.length, createdAtCutoff },
      '[Timeout] runClaimTimeoutPass starting',
    );

    for (const bid of candidateBids) {
      try {
        if (typeof this.escrowService.claimTimeout !== 'function') {
          logger.debug(
            { escrowId: bid.escrowId },
            '[Timeout] claimTimeout method missing on escrow provider — skipping',
          );
          continue;
        }
        const result = await this.escrowService.claimTimeout(bid.escrowId);
        claimedEscrowIds.push(bid.escrowId);
        tgClaimTimeoutAttemptsTotal.inc({ result: 'success' });
        logger.info(
          {
            escrowId: bid.escrowId,
            bidId: bid.id,
            taskId: bid.taskId,
            executorPublicKey: bid.executorPublicKey,
            amountTransferred: result.amountTransferred.toString(),
            beneficiary: result.beneficiary,
            transactionHash: result.transactionHash,
          },
          '[Timeout] claim_timeout executed — collateral returned to executor',
        );
        await this.outbox?.emit({
          type: 'escrow_claim_timeout_executed',
          aggregateType: 'bid',
          aggregateId: bid.id,
          payload: {
            bidId: bid.id,
            escrowId: bid.escrowId,
            executorPublicKey: bid.executorPublicKey,
            amountTransferred: result.amountTransferred.toString(),
          },
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (/ClaimTooEarly/i.test(msg)) {
          tgClaimTimeoutAttemptsTotal.inc({ result: 'claim_too_early' });
          logger.debug(
            { escrowId: bid.escrowId, bidId: bid.id },
            '[Timeout] claim_timeout on-chain returned ClaimTooEarly — bid off-chain age 14d but ledger not yet; will retry next cycle',
          );
        } else {
          tgClaimTimeoutAttemptsTotal.inc({ result: 'error' });
          logger.error(
            { err, escrowId: bid.escrowId, bidId: bid.id, taskId: bid.taskId },
            '[Timeout] failed to run claim_timeout on escrow',
          );
        }
        continue;
      }
    }

    return { claimedEscrowIds };
  }

  schedule(
    cronExpression: string = '*/5 * * * *',
    opts: { includeClaimTimeout?: boolean } = { includeClaimTimeout: true },
  ): ScheduledTask {
    return cron.schedule(cronExpression, () => {
      this.runOnce().catch((err) => logger.error({ err }, '[Timeout] runOnce scheduled job failed'));
      if (opts.includeClaimTimeout) {
        this.runClaimTimeoutPass().catch((err) =>
          logger.error({ err }, '[Timeout] runClaimTimeoutPass scheduled job failed'),
        );
      }
    });
  }
}
