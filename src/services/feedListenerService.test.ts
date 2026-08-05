import { Keypair } from '@stellar/stellar-sdk';
import { Task } from '../models/task';
import { TaskFeedService } from './taskFeedService';
import { FeedListenerService } from './feedListenerService';
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

describe('FeedListenerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs a message when the channel publishes a new tick', async () => {
    const feedService = new TaskFeedService(Keypair.random());
    new FeedListenerService(feedService);

    await feedService.publishTask(makeTask({ id: 'task-42' }));

    expect(logger.info).toHaveBeenCalledWith(
      { sequence: 1, taskId: 'task-42' },
      expect.stringMatching(/\[Feed Listener\] received tick — new task available/),
    );
  });

  it('stops receiving ticks after stop() is called', async () => {
    const feedService = new TaskFeedService(Keypair.random());
    const listener = new FeedListenerService(feedService);

    listener.stop();
    await feedService.publishTask(makeTask());

    const listenerCalls = (logger.info as jest.Mock).mock.calls.filter(
      (call: unknown[]) => String(call[1] ?? '').includes('[Feed Listener]'),
    );
    expect(listenerCalls).toHaveLength(0);
  });
});
