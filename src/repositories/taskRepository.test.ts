import { TaskRepository } from './taskRepository';
import { Task } from '../models/task';

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

describe('TaskRepository', () => {
  it('saves and finds a task by id', () => {
    const repo = new TaskRepository();
    const task = makeTask();
    repo.save(task);
    expect(repo.findById(task.id)).toEqual(task);
  });

  it('returns undefined for an unknown id', () => {
    const repo = new TaskRepository();
    expect(repo.findById('missing')).toBeUndefined();
  });

  it('lists all saved tasks', () => {
    const repo = new TaskRepository();
    const taskA = makeTask({ id: 'task-a' });
    const taskB = makeTask({ id: 'task-b' });
    repo.save(taskA);
    repo.save(taskB);
    expect(repo.list()).toEqual([taskA, taskB]);
  });
});
