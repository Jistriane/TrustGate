import { swaggerSpec } from './swagger';

describe('swaggerSpec', () => {
  const spec = swaggerSpec as { paths: Record<string, unknown>; info: { title: string } };

  it('has the expected info block', () => {
    expect(spec.info.title).toBe('TrustGate API');
  });

  it('documents every real HTTP endpoint', () => {
    const expectedPaths = [
      '/health',
      '/health/detailed',
      '/metrics',
      '/executors/register',
      '/tasks',
      '/tasks/{id}/select',
      '/tasks/{id}/complete',
      '/bids',
      '/admin/timeout-check',
      '/executor/tasks/{taskId}/result',
      '/feed/stream',
    ];

    for (const path of expectedPaths) {
      expect(spec.paths).toHaveProperty(path);
    }
  });
});
