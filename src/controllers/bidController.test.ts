import { config as loadEnv } from 'dotenv';
import path from 'path';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../app';
import { Task } from '../models/task';
import { TaskRepository } from '../repositories/taskRepository';
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

function makeOpenTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requesterPublicKey: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePriceStroops: 1000000000n,
    description: 'Do something useful',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    status: 'OPEN',
    ...overrides,
  };
}

describe('POST /bids', () => {
  it('returns 404 when the task does not exist', async () => {
    const app = createApp();
    const executor = Keypair.random();

    const response = await request(app).post('/bids').send({
      taskId: 'missing-task',
      executor: executor.publicKey(),
      secret: executor.secret(),
      amount: '90',
      collateral: '10',
    });

    expect(response.status).toBe(404);
  });

  it('returns 409 when the task is not OPEN', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeOpenTask({ id: 'task-not-open', status: 'ASSIGNED' });
    await taskRepository.save(task);

    const executor = Keypair.random();
    const response = await request(app).post('/bids').send({
      taskId: task.id,
      executor: executor.publicKey(),
      secret: executor.secret(),
      amount: '90',
      collateral: '10',
    });

    expect(response.status).toBe(409);
  });

  it('rejects a payload with mismatched secret/executor', async () => {
    const app = createApp();
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeOpenTask({ id: 'task-mismatch' });
    await taskRepository.save(task);

    const executor = Keypair.random();
    const other = Keypair.random();

    const response = await request(app).post('/bids').send({
      taskId: task.id,
      executor: executor.publicKey(),
      secret: other.secret(),
      amount: '90',
      collateral: '10',
    });

    expect(response.status).toBe(400);
  });

  it('rejects an invalid payload', async () => {
    const app = createApp();
    const response = await request(app).post('/bids').send({});
    expect(response.status).toBe(400);
  });

  it('rejects bids from executors that are not on the allow-list', async () => {
    const fakeRegistryService = {
      async isRegistered(_: string) {
        return false;
      },
      async registerExecutor() {
        throw new Error('not implemented');
      },
      async getExecutor() {
        throw new Error('not implemented');
      },
    };

    const fakeEscrowService = {
      async createEscrow() {
        return 'CFAKEESCROWID000000000000000000000000000000000000';
      },
      async releaseMilestone() {
        throw new Error('not implemented');
      },
      async confiscate() {
        throw new Error('not implemented');
      },
    };

    const app = createApp({
      registryService: fakeRegistryService,
      escrowService: fakeEscrowService,
    });
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeOpenTask({ id: 'task-unauthorized' });
    await taskRepository.save(task);

    const executor = Keypair.random();
    const response = await request(app).post('/bids').send({
      taskId: task.id,
      executor: executor.publicKey(),
      secret: executor.secret(),
      amount: '90',
      collateral: '10',
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'executor is not registered' });
  });

  it('creates a bid when the executor is registered and escrow is created', async () => {
    const fakeRegistryService = {
      async isRegistered(_: string) {
        return true;
      },
      async registerExecutor() {
        throw new Error('not implemented');
      },
      async getExecutor() {
        throw new Error('not implemented');
      },
    };

    const fakeEscrowService = {
      async createEscrow() {
        return 'CFAKEESCROWID000000000000000000000000000000000000';
      },
      async releaseMilestone() {
        throw new Error('not implemented');
      },
      async confiscate() {
        throw new Error('not implemented');
      },
    };

    const app = createApp({
      registryService: fakeRegistryService,
      escrowService: fakeEscrowService,
    });
    const taskRepository = app.get('taskRepository') as TaskRepository;
    const task = makeOpenTask({ id: 'task-authorized' });
    await taskRepository.save(task);

    const executor = Keypair.random();
    const response = await request(app).post('/bids').send({
      taskId: task.id,
      executor: executor.publicKey(),
      secret: executor.secret(),
      amount: '90',
      collateral: '10',
    });

    expect(response.status).toBe(201);
    expect(response.body.taskId).toBe(task.id);
    expect(response.body.executorPublicKey).toBe(executor.publicKey());
    expect(response.body.escrowId).toBe('CFAKEESCROWID000000000000000000000000000000000000');
    expect(response.body.status).toBe('PENDING');
  });

  describeIfRealEscrowApi('with a live Trustless Work API key', () => {
    it('creates the escrow on the network and saves the bid', async () => {
      const app = createApp();
      const taskRepository = app.get('taskRepository') as TaskRepository;
      const task = makeOpenTask({ id: 'task-live-escrow' });
      await taskRepository.save(task);

      const executor = Keypair.random();
      const response = await request(app)
        .post('/bids')
        .send({
          taskId: task.id,
          executor: executor.publicKey(),
          secret: executor.secret(),
          amount: '90',
          collateral: '10',
        });

      expect(response.status).toBe(201);
      expect(response.body.taskId).toBe(task.id);
      expect(response.body.executorPublicKey).toBe(executor.publicKey());
      expect(response.body.escrowId).toBeTruthy();
      expect(response.body.status).toBe('PENDING');
    }, 30000);
  });
});
