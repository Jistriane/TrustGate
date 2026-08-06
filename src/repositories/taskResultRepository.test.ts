import { InMemoryTaskResultRepository, TaskResultRecord } from './taskResultRepository';

type SaveArg = Omit<TaskResultRecord, 'createdAt'>;

function makeTaskResult(overrides: Partial<SaveArg> = {}): SaveArg {
  return {
    taskId: 'task-result-' + Math.random().toString(36).slice(2, 8),
    payload: { answer: 42, items: [{ ok: true }] },
    payloadHash: 'sha256-' + Math.random().toString(36).slice(2, 20),
    ...overrides,
  };
}

describe('TaskResultRepository (InMemoryTaskResultRepository)', () => {
  it('upsert + findByTaskId returns record with createdAt', async () => {
    const repo = new InMemoryTaskResultRepository();
    const r = makeTaskResult();
    await repo.upsert(r);
    const got = await repo.findByTaskId(r.taskId);
    expect(got).toBeDefined();
    expect(got?.taskId).toBe(r.taskId);
    expect(got?.payload).toEqual(r.payload);
    expect(got?.payloadHash).toBe(r.payloadHash);
    expect(typeof got?.createdAt).toBe('string');
  });

  it('findByTaskId returns undefined for non-existent task', async () => {
    const repo = new InMemoryTaskResultRepository();
    await expect(repo.findByTaskId('never-saved')).resolves.toBeUndefined();
  });

  it('upsert on existing taskId overwrites (idempotency)', async () => {
    const repo = new InMemoryTaskResultRepository();
    const id = 'upsert-id';
    await repo.upsert(makeTaskResult({ taskId: id, payloadHash: 'H1' }));
    await repo.upsert(makeTaskResult({ taskId: id, payloadHash: 'H2', payload: { novo: true } }));
    const got = await repo.findByTaskId(id);
    expect(got?.payloadHash).toBe('H2');
    expect((got?.payload as any).novo).toBe(true);
  });
});
