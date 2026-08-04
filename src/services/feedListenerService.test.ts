import { Keypair } from '@stellar/stellar-sdk';
import { Task } from '../models/task';
import { TaskFeedService } from './taskFeedService';
import { FeedListenerService } from './feedListenerService';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    requester: 'GA5G6L2CGI6QJUOE4PPRVMAZVRRBYJ3HOGQ2NWFKKMGBJB7SZIXIKSTO',
    reservePrice: 100,
    description: 'Do something useful',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    status: 'OPEN',
    ...overrides,
  };
}

describe('FeedListenerService', () => {
  it('logs a message when the channel publishes a new tick', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const feedService = new TaskFeedService(Keypair.random());
    new FeedListenerService(feedService);

    await feedService.publishTask(makeTask({ id: 'task-42' }));

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Feed Listener\] received tick #1.*task-42/),
    );

    logSpy.mockRestore();
  });

  it('stops receiving ticks after stop() is called', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const feedService = new TaskFeedService(Keypair.random());
    const listener = new FeedListenerService(feedService);

    listener.stop();
    await feedService.publishTask(makeTask());

    const listenerLogs = logSpy.mock.calls.filter((call) =>
      String(call[0]).includes('[Feed Listener]'),
    );
    expect(listenerLogs).toHaveLength(0);

    logSpy.mockRestore();
  });
});
