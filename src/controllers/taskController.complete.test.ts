import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';
import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';
import { isRealApiKey } from '../testHelpers/liveApiKey';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

process.env.NETWORK = 'local';

process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
process.env.MARKETPLACE_WALLET = process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
process.env.REGISTRY_CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';

const describeIfRealEscrowApi = isRealApiKey(process.env.TRUSTLESS_WORK_API_KEY)
  ? describe
  : describe.skip;

const requesterKeypair = Keypair.random();
const REQUESTER_PUBLIC_KEY = requesterKeypair.publicKey();
const REQUESTER_SECRET = requesterKeypair.secret();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requesterPublicKey: REQUESTER_PUBLIC_KEY,
    reservePriceStroops: 10000000000n,
    description: 'Do something useful',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    status: 'ASSIGNED',
    ...overrides,
  };
}

function makeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 'bid-1',
    taskId: 'task-1',
    executorPublicKey: 'GBEXECUTOR000000000000000000000000000000000000000000000',
    amountStroops: 5000000000n,
    collateralStroops: 500000000n,
    escrowId: 'CESCROW00000000000000000000000000000000000000000000000',
    status: 'SELECTED',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('POST /tasks/:id/complete', () => {
  it('rejects an invalid payload', async () => {
    const app = createApp();
    const response = await request(app).post('/tasks/task-1/complete').send({});
    expect(response.status).toBe(400);
  });

  it('rejects a payload with mismatched secret/requester', async () => {
    const app = createApp();
    const other = Keypair.random();
    const response = await request(app).post('/tasks/task-1/complete').send({
      requester: REQUESTER_PUBLIC_KEY,
      secret: other.secret(),
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown task', async () => {
    const app = createApp();
    const response = await request(app).post('/tasks/unknown-task/complete').send({
      requester: REQUESTER_PUBLIC_KEY,
      secret: REQUESTER_SECRET,
    });
    expect(response.status).toBe(404);
  });

  it('returns 403 when the caller is not the task requester', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeTask({ id: 'task-not-owner' });
    await taskRepository.save(task);

    const other = Keypair.random();
    const response = await request(app).post(`/tasks/${task.id}/complete`).send({
      requester: other.publicKey(),
      secret: other.secret(),
    });

    expect(response.status).toBe(403);
  });

  it('returns 409 when the task is not ASSIGNED', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeTask({ id: 'task-still-open', status: 'OPEN' });
    await taskRepository.save(task);

    const response = await request(app).post(`/tasks/${task.id}/complete`).send({
      requester: REQUESTER_PUBLIC_KEY,
      secret: REQUESTER_SECRET,
    });

    expect(response.status).toBe(409);
  });

  it('returns 409 when there is no selected bid for the task', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeTask({ id: 'task-no-selected-bid' });
    await taskRepository.save(task);

    const response = await request(app).post(`/tasks/${task.id}/complete`).send({
      requester: REQUESTER_PUBLIC_KEY,
      secret: REQUESTER_SECRET,
    });

    expect(response.status).toBe(409);
  });

  describeIfRealEscrowApi('with a live Trustless Work API key', () => {
    it('releases the escrow and marks the task COMPLETED', async () => {
      const app = createApp();
      const taskRepository = app.get('taskRepository') as TaskRepository;
      const bidRepository = app.get('bidRepository') as BidRepository;

      const task = makeTask({ id: 'task-complete-live' });
      await taskRepository.save(task);
      const bid = makeBid({ taskId: task.id });
      await bidRepository.save(bid);

      const response = await request(app).post(`/tasks/${task.id}/complete`).send({
        requester: REQUESTER_PUBLIC_KEY,
        secret: REQUESTER_SECRET,
      });

      expect(response.status).toBe(200);
      expect(response.body.task.status).toBe('COMPLETED');
      expect(response.body.release.success).toBe(true);
      await expect(taskRepository.findById(task.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    }, 30000);
  });
});
