import { loadStellarConfig } from '../config/stellar';
import { HealthCheckService } from './healthCheckService';

describe('HealthCheckService.check', () => {
  it('reports Redis as not_configured when REDIS_URL is unset', async () => {
    const previous = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    const service = new HealthCheckService({
      ...loadStellarConfig(),
      rpcUrl: 'http://127.0.0.1:1',
    });
    const health = await service.check();

    expect(health.dependencies.redis).toEqual({ status: 'not_configured' });

    if (previous !== undefined) process.env.REDIS_URL = previous;
  });

  it('reports Stellar RPC as down when unreachable', async () => {
    const service = new HealthCheckService({
      ...loadStellarConfig(),
      rpcUrl: 'http://127.0.0.1:1',
    });
    const health = await service.check();

    expect(health.dependencies.stellarRpc.status).toBe('down');
    expect(health.status).toBe('degraded');
  }, 15000);
});
