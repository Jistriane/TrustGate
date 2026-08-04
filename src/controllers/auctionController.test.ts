import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';
import { Task } from '../models/task';
import { Bid } from '../models/bid';
import { TaskRepository } from '../repositories/taskRepository';
import { BidRepository } from '../repositories/bidRepository';

loadEnv({ path: path.join(__dirname, '..', '..', '.env') });

process.env.USDC_ISSUER = process.env.USDC_ISSUER ?? Keypair.random().publicKey();
process.env.MARKETPLACE_WALLET = process.env.MARKETPLACE_WALLET ?? Keypair.random().publicKey();
process.env.REGISTRY_CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TRUSTLESS_WORK_API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? 'test-key';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET ?? Keypair.random().secret();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requester: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePrice: 1000,
    description: 'Do something useful',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    status: 'OPEN',
    ...overrides,
  };
}

function makeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 'bid-1',
    taskId: 'task-1',
    executor: 'GBEXECUTOR000000000000000000000000000000000000000000000',
    amount: 500,
    collateral: 50,
    escrowId: 'CESCROW00000000000000000000000000000000000000000000000',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('POST /tasks/:id/select', () => {
  it('rejects requests without the admin secret header', async () => {
    const app = createApp();
    const response = await request(app).post('/tasks/task-1/select');
    expect(response.status).toBe(401);
  });

  it('rejects requests with the wrong admin secret', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/tasks/task-1/select')
      .set('x-admin-secret', 'wrong-secret');
    expect(response.status).toBe(401);
  });

  it('returns 404 for an unknown task', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/tasks/unknown-task/select')
      .set('x-admin-secret', process.env.ADMIN_SECRET as string);
    expect(response.status).toBe(404);
  });

  it('selects the winning bid, assigns the task, and returns executor data', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const bidRepository = app.get('bidRepository') as BidRepository;

    const task = makeTask({ id: 'task-select' });
    taskRepository.save(task);

    const lowBid = makeBid({ id: 'bid-low', taskId: task.id, amount: 400 });
    const highBid = makeBid({ id: 'bid-high', taskId: task.id, amount: 900 });
    bidRepository.save(highBid);
    bidRepository.save(lowBid);

    const response = await request(app)
      .post(`/tasks/${task.id}/select`)
      .set('x-admin-secret', process.env.ADMIN_SECRET as string);

    expect(response.status).toBe(200);
    expect(response.body.task.status).toBe('ASSIGNED');
    expect(response.body.winningBid.id).toBe('bid-low');
    expect(response.body.winningBid.executor).toBe(lowBid.executor);

    expect(taskRepository.findById(task.id)?.status).toBe('ASSIGNED');
    expect(bidRepository.findById('bid-high')?.status).toBe('REJECTED');
  });

  it('returns 409 when the task has no pending bids', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeTask({ id: 'task-no-bids' });
    taskRepository.save(task);

    const response = await request(app)
      .post(`/tasks/${task.id}/select`)
      .set('x-admin-secret', process.env.ADMIN_SECRET as string);

    expect(response.status).toBe(409);
  });
});
