import { TaskRepository } from './taskRepository';
import { Task } from '../models/task';

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

describe('TaskRepository', () => {
  it('saves and finds a task by id', async () => {
    const repo = new TaskRepository();
    const task = makeTask();
    await repo.save(task);
    await expect(repo.findById(task.id)).resolves.toEqual(task);
  });

  it('returns undefined for an unknown id', async () => {
    const repo = new TaskRepository();
    await expect(repo.findById('missing')).resolves.toBeUndefined();
  });

  it('lists all saved tasks', async () => {
    const repo = new TaskRepository();
    const taskA = makeTask({ id: 'task-a' });
    const taskB = makeTask({ id: 'task-b' });
    await repo.save(taskA);
    await repo.save(taskB);
    await expect(repo.list()).resolves.toEqual([taskA, taskB]);
  });

  it('listAssignedDeadlineBefore filters only ASSIGNED with deadline before cutoff', async () => {
    const repo = new TaskRepository();
    const future = Date.now() + 10_000;
    const past = Date.now() - 10_000;
    const assignedPast = makeTask({ id: 'ta-past', status: 'ASSIGNED', deadline: new Date(past).toISOString() });
    const assignedFuture = makeTask({ id: 'ta-fut', status: 'ASSIGNED', deadline: new Date(future).toISOString() });
    const openPast = makeTask({ id: 'to-past', status: 'OPEN', deadline: new Date(past).toISOString() });
    await repo.save(assignedPast);
    await repo.save(assignedFuture);
    await repo.save(openPast);
    const result = await repo.listAssignedDeadlineBefore(new Date().toISOString());
    expect(result.map((t) => t.id)).toEqual(['ta-past']);
  });

  it('listAssignedDeadlineBefore accepts Date and ISO string', async () => {
    const repo = new TaskRepository();
    const t = makeTask({ id: 't1', status: 'ASSIGNED', deadline: new Date(Date.now() - 1000).toISOString() });
    await repo.save(t);
    const viaDate = await repo.listAssignedDeadlineBefore(new Date());
    const viaIso = await repo.listAssignedDeadlineBefore(new Date().toISOString());
    expect(viaDate).toHaveLength(1);
    expect(viaIso).toHaveLength(1);
  });
});
