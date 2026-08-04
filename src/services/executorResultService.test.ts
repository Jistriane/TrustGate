import { ExecutorResultService } from './executorResultService';
import { InMemoryTaskResultRepository } from '../repositories/taskResultRepository';

describe('ExecutorResultService', () => {
  it('publishes and returns a persisted result', async () => {
    const repo = new InMemoryTaskResultRepository();
    const service = new ExecutorResultService(repo);
    await service.publish('task-123', { ok: true });
    const result = await service.get('task-123');

    expect(result?.taskId).toBe('task-123');
    expect(result?.payloadHash).toMatch(/^sha256:/);
  });
});
