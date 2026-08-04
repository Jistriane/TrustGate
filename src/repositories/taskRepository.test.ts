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
});
