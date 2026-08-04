import { ExecutorResultService } from './executorResultService';

describe('ExecutorResultService.getResult', () => {
  it('returns a fixed result payload for the given task', () => {
    const service = new ExecutorResultService();
    const result = service.getResult('task-123');

    expect(result.taskId).toBe('task-123');
    expect(result.resultHash).toMatch(/^sha256:/);
    expect(result.link).toContain('task-123');
  });
});
