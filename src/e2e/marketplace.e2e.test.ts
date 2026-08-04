import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';
import { RegistryServiceLike, ExecutorInfo } from '../services/registryService';
import { MppChargeServiceLike, ChargeResult } from '../services/mppChargeService';
import { EscrowServiceLike, ReleaseResult } from '../services/escrowService';
import { X402PaymentService } from '../services/x402PaymentService';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { formatUsdcStroopsToDecimal, parseUsdcDecimalToStroops } from '../utils/money';

process.env.NETWORK = process.env.NETWORK ?? 'local';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET ?? Keypair.random().secret();
delete process.env.MARKETPLACE_WALLET;

/**
 * Full marketplace lifecycle, end to end, with every network-touching
 * integration replaced by an in-memory fake: Registry (Soroban), MPP charge
 * (USDC SAC transfer), Trustless Work (escrow), and the x402 payment client.
 * No real Stellar RPC, Horizon, or Trustless Work/OZ Channels call happens —
 * this only proves our own request/response and repository-state wiring.
 */
describe('Marketplace E2E flow (mocked)', () => {
  function makeFakeRegistryService(): RegistryServiceLike & {
    registered: Map<string, ExecutorInfo>;
  } {
    const registered = new Map<string, ExecutorInfo>();
    return {
      registered,
      async registerExecutor(executor, metadataUri) {
        registered.set(executor.publicKey(), { metadata_uri: metadataUri });
      },
      async isRegistered(executorPublicKey) {
        return registered.has(executorPublicKey);
      },
      async getExecutor(executorPublicKey) {
        const info = registered.get(executorPublicKey);
        if (!info) throw new Error('not registered');
        return info;
      },
    };
  }

  function makeFakeMppChargeService(): MppChargeServiceLike & {
    charges: { requester: string; reservePriceStroops: bigint }[];
  } {
    const charges: { requester: string; reservePriceStroops: bigint }[] = [];
    return {
      charges,
      calculateFeeStroops(reservePriceStroops) {
        return (reservePriceStroops * 5n + 500n) / 1000n;
      },
      async chargeListingFee(requester, reservePriceStroops): Promise<ChargeResult> {
        charges.push({ requester: requester.publicKey(), reservePriceStroops });
        const feeStroops = this.calculateFeeStroops(reservePriceStroops);
        return {
          feeAmount: formatUsdcStroopsToDecimal(feeStroops),
          feeStroops: feeStroops.toString(),
          txHash: 'fake-charge-tx',
        };
      },
    };
  }

  function makeFakeEscrowService(): EscrowServiceLike & {
    escrows: Map<string, { collateral: number; released: boolean }>;
  } {
    const escrows = new Map<string, { collateral: number; released: boolean }>();
    let counter = 0;
    return {
      escrows,
      async createEscrow(_executor, taskId, collateralAmount) {
        const escrowId = `CFAKEESCROW${++counter}${taskId}`.slice(0, 56).padEnd(56, '0');
        escrows.set(escrowId, { collateral: collateralAmount, released: false });
        return escrowId;
      },
      async releaseMilestone(escrowId): Promise<ReleaseResult> {
        const escrow = escrows.get(escrowId);
        if (!escrow) throw new Error('unknown escrow');
        escrow.released = true;
        return {
          success: true,
          transactionHash: 'fake-release-tx',
          amountReleased: escrow.collateral,
          receiver: 'GFAKEEXECUTOR',
        };
      },
      async confiscate(escrowId, collateralAmount, requesterSharePct = 0.7) {
        const requesterShare = Math.round(collateralAmount * requesterSharePct * 100) / 100;
        return {
          success: true,
          disputeId: `fake-dispute-${escrowId}`,
          status: 'open',
          requesterShare,
          marketplaceShare: Math.round((collateralAmount - requesterShare) * 100) / 100,
        };
      },
    };
  }

  it('runs the full lifecycle: register -> publish -> bid -> select -> pay -> release', async () => {
    const fakeRegistryService = makeFakeRegistryService();
    const fakeMppChargeService = makeFakeMppChargeService();
    const fakeEscrowService = makeFakeEscrowService();

    const app = createApp({
      registryService: fakeRegistryService,
      mppChargeService: fakeMppChargeService,
      escrowService: fakeEscrowService,
    });

    const requester = Keypair.random();
    const executor = Keypair.random();

    // 1. Registrar — executor registers on the (fake) Registry allow-list.
    const registerRes = await request(app)
      .post('/executors/register')
      .send({ secret: executor.secret(), metadataUri: 'https://executor.example.com/meta.json' });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.publicKey).toBe(executor.publicKey());
    expect(fakeRegistryService.registered.has(executor.publicKey())).toBe(true);

    // 2. Publicar Task — requester lists a task, paying the (fake) listing fee.
    const deadline = new Date(Date.now() + 86400000).toISOString();
    const createTaskRes = await request(app).post('/tasks').send({
      requester: requester.publicKey(),
      secret: requester.secret(),
      reservePrice: '1000',
      description: 'Summarize this document',
      deadline,
    });

    expect(createTaskRes.status).toBe(201);
    expect(createTaskRes.body.status).toBe('OPEN');
    const taskId = createTaskRes.body.id as string;
    expect(fakeMppChargeService.charges).toEqual([
      { requester: requester.publicKey(), reservePriceStroops: parseUsdcDecimalToStroops('1000') },
    ]);

    const taskRepository = app.get('taskRepository') as TaskRepository;
    const bidRepository = app.get('bidRepository') as BidRepository;
    await expect(taskRepository.findById(taskId)).resolves.toMatchObject({ status: 'OPEN' });

    // 3. Lance — executor bids, locking collateral in a (fake) escrow.
    const bidRes = await request(app).post('/bids').send({
      taskId,
      executor: executor.publicKey(),
      secret: executor.secret(),
      amount: '900',
      collateral: '50',
    });

    expect(bidRes.status).toBe(201);
    expect(bidRes.body.status).toBe('PENDING');
    const escrowId = bidRes.body.escrowId as string;
    expect(fakeEscrowService.escrows.has(escrowId)).toBe(true);
    await expect(bidRepository.findById(bidRes.body.id)).resolves.toMatchObject({ status: 'PENDING' });

    // 4. Selecionar — marketplace admin selects the (only) bid as winner.
    const selectRes = await request(app)
      .post(`/tasks/${taskId}/select`)
      .set('x-admin-secret', process.env.ADMIN_SECRET as string);

    expect(selectRes.status).toBe(200);
    expect(selectRes.body.task.status).toBe('ASSIGNED');
    expect(selectRes.body.winningBid.executorPublicKey).toBe(executor.publicKey());
    await expect(taskRepository.findById(taskId)).resolves.toMatchObject({ status: 'ASSIGNED' });
    await expect(bidRepository.findById(bidRes.body.id)).resolves.toMatchObject({ status: 'SELECTED' });

    // 5. Pagar x402 — requester pays the executor's (mocked) result endpoint.
    const fakeFetchWithPayment = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ taskId, payloadHash: 'sha256:fake', payload: { ok: true } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const x402PaymentService = new X402PaymentService(requester.secret(), {
      fetchWithPayment: fakeFetchWithPayment,
    });

    const paymentResult = (await x402PaymentService.payForResult(
      taskId,
      'https://executor.example.com',
    )) as { taskId: string; payloadHash: string };

    expect(paymentResult.taskId).toBe(taskId);
    expect(fakeFetchWithPayment).toHaveBeenCalledWith(
      `https://executor.example.com/executor/tasks/${taskId}/result`,
    );

    // 6. Liberar Escrow — requester marks the task complete, releasing collateral.
    const completeRes = await request(app).post(`/tasks/${taskId}/complete`).send({
      requester: requester.publicKey(),
      secret: requester.secret(),
    });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.task.status).toBe('COMPLETED');
    expect(completeRes.body.release.success).toBe(true);
    await expect(taskRepository.findById(taskId)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(fakeEscrowService.escrows.get(escrowId)?.released).toBe(true);
  }, 15000);
});
