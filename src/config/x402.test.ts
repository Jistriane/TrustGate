import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { RequestHandler } from 'express';
import { createApp } from '../app';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
process.env.MARKETPLACE_WALLET = process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
process.env.REGISTRY_CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';

const hasRealOzApiKey = Boolean(process.env.OZ_API_KEY) && process.env.OZ_API_KEY !== 'fake-oz-key';
const describeIfRealFacilitator = hasRealOzApiKey ? describe : describe.skip;

const fakeResultGate: RequestHandler = (_req, res, next) => {
  res.setHeader('x-fake-result-gate', 'true');
  next();
};

describe('GET /executor/tasks/:taskId/result', () => {
  it('is not mounted when OZ_API_KEY is unset', async () => {
    const previous = process.env.OZ_API_KEY;
    delete process.env.OZ_API_KEY;

    const app = createApp();
    const response = await request(app).get('/executor/tasks/task-1/result');
    expect(response.status).toBe(404);

    if (previous !== undefined) process.env.OZ_API_KEY = previous;
  });

  it('mounts the executor result endpoint when resultPaymentGate override is provided', async () => {
    const previous = process.env.OZ_API_KEY;
    delete process.env.OZ_API_KEY;

    const app = createApp({ resultPaymentGate: fakeResultGate });
    const response = await request(app).get('/executor/tasks/task-1/result');

    expect(response.headers['x-fake-result-gate']).toBe('true');
    expect([200, 404, 409, 402, 503]).toContain(response.status);

    if (previous !== undefined) process.env.OZ_API_KEY = previous;
  });

  it('returns 200 with result body when resultPaymentGate override is provided and task is assigned', async () => {
    const previous = process.env.OZ_API_KEY;
    delete process.env.OZ_API_KEY;

    const app = createApp({ resultPaymentGate: fakeResultGate });
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const bidRepository = app.get('bidRepository') as BidRepository;

    await taskRepository.save({
      id: 'task-payment-test',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Deliver result',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'ASSIGNED',
    });
    await bidRepository.save({
      id: 'bid-selected',
      taskId: 'task-payment-test',
      executorPublicKey: 'GEXECUTOR',
      amountStroops: 500000000n,
      collateralStroops: 100000000n,
      escrowId: 'escrow-1',
      status: 'SELECTED',
      createdAt: new Date().toISOString(),
    });
    await request(app)
      .post('/executor/tasks/task-payment-test/result')
      .send({ executorPublicKey: 'GEXECUTOR', payload: { ok: true } });

    const response = await request(app).get('/executor/tasks/task-payment-test/result');

    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe('task-payment-test');
    expect(response.body.payloadHash).toMatch(/^sha256:/);
    expect(response.headers['x-fake-result-gate']).toBe('true');

    if (previous !== undefined) process.env.OZ_API_KEY = previous;
  });

  it('returns 200 with result body when resultPaymentGate override is provided and task is completed', async () => {
    const previous = process.env.OZ_API_KEY;
    delete process.env.OZ_API_KEY;

    const app = createApp({ resultPaymentGate: fakeResultGate });
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const bidRepository = app.get('bidRepository') as BidRepository;

    await taskRepository.save({
      id: 'task-payment-completed',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Deliver final result',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'ASSIGNED',
    });
    await bidRepository.save({
      id: 'bid-selected-completed',
      taskId: 'task-payment-completed',
      executorPublicKey: 'GEXECUTOR',
      amountStroops: 500000000n,
      collateralStroops: 100000000n,
      escrowId: 'escrow-2',
      status: 'SELECTED',
      createdAt: new Date().toISOString(),
    });
    await request(app)
      .post('/executor/tasks/task-payment-completed/result')
      .send({ executorPublicKey: 'GEXECUTOR', payload: { ok: true } });
    await taskRepository.save({
      id: 'task-payment-completed',
      requesterPublicKey: 'GREQUESTER',
      reservePriceStroops: 1000000000n,
      description: 'Deliver final result',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      status: 'COMPLETED',
    });

    const response = await request(app).get('/executor/tasks/task-payment-completed/result');

    expect(response.status).toBe(200);
    expect(response.body.taskId).toBe('task-payment-completed');
    expect(response.body.payloadHash).toMatch(/^sha256:/);
    expect(response.headers['x-fake-result-gate']).toBe('true');

    if (previous !== undefined) process.env.OZ_API_KEY = previous;
  });

  it('returns 503 (not a bare 500) when the configured facilitator is unreachable', async () => {
    const previous = process.env.OZ_API_KEY;
    process.env.OZ_API_KEY = 'fake-oz-key';

    const app = createApp();
    const response = await request(app).get('/executor/tasks/task-1/result');

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('payment gate unavailable');

    if (previous === undefined) delete process.env.OZ_API_KEY;
    else process.env.OZ_API_KEY = previous;
  }, 15000);

  describeIfRealFacilitator('with a live OZ Channels facilitator', () => {
    it('returns 402 when no payment header is present', async () => {
      const app = createApp();
      const response = await request(app).get('/executor/tasks/task-1/result');
      expect(response.status).toBe(402);
    }, 15000);
  });
});
