import { Keypair } from '@stellar/stellar-sdk';
import { Task } from '../models/task';
import { TaskFeedService } from './taskFeedService';

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

describe('TaskFeedService', () => {
  it('publishes a tick with an increasing sequence number, logged to console', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
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

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\[Task Feed\] tick #1/));
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\[Task Feed\] tick #2/));

    logSpy.mockRestore();
  });

  it('signs each tick with the signing key', async () => {
    jest.spyOn(console, 'log').mockImplementation();
    const signingKey = Keypair.random();
    const service = new TaskFeedService(signingKey);

    const task = makeTask();
    const tick = await service.publishTask(task);

    const payload = `${tick.sequence}:${tick.taskId}:${tick.timestamp}`;
    const isValid = signingKey.verify(Buffer.from(payload), Buffer.from(tick.signature, 'hex'));
    expect(isValid).toBe(true);

    jest.restoreAllMocks();
  });
});
