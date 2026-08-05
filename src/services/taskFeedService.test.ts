import { Keypair } from '@stellar/stellar-sdk';
import { Task } from '../models/task';
import { TaskFeedService } from './taskFeedService';
import { logger } from '../config/logger';

jest.mock('../config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
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

describe('TaskFeedService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes a tick with an increasing sequence number, logged via structured logger', async () => {
    const signingKey = Keypair.random();
    const service = new TaskFeedService(signingKey);

    const taskA = makeTask({ id: 'task-a' });
    const taskB = makeTask({ id: 'task-b' });

    const tickA = await service.publishTask(taskA);
    const tickB = await service.publishTask(taskB);

    expect(tickA.sequence).toBe(1);
    expect(tickB.sequence).toBe(2);
    expect(tickA.taskId).toBe('task-a');
    expect(tickB.taskId).toBe('task-b');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, taskId: 'task-a', signingPublicKey: signingKey.publicKey() }),
      expect.stringMatching(/\[Task Feed\] tick — task published/),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 2, taskId: 'task-b', signingPublicKey: signingKey.publicKey() }),
      expect.stringMatching(/\[Task Feed\] tick — task published/),
    );
  });

  it('signs each tick with the signing key', async () => {
    const signingKey = Keypair.random();
    const service = new TaskFeedService(signingKey);

    const task = makeTask();
    const tick = await service.publishTask(task);

    const payload = `${tick.sequence}:${tick.taskId}:${tick.timestamp}`;
    const isValid = signingKey.verify(Buffer.from(payload), Buffer.from(tick.signature, 'hex'));
    expect(isValid).toBe(true);
  });
});
