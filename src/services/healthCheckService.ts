import { rpc } from '@stellar/stellar-sdk';
import { createClient } from 'redis';
import { StellarConfig } from '../config/stellar';

export type DependencyStatus = 'up' | 'down' | 'not_configured';

export interface DependencyHealth {
  status: DependencyStatus;
  latencyMs?: number;
  detail?: string;
}

export interface DetailedHealth {
  status: 'ok' | 'degraded';
  dependencies: {
    stellarRpc: DependencyHealth;
    redis: DependencyHealth;
  };
}

export class HealthCheckService {
  constructor(private readonly config: StellarConfig) {}

  private async checkStellarRpc(): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      const server = new rpc.Server(this.config.rpcUrl, { allowHttp: this.config.allowHttp });
      const health = await server.getHealth();
      return {
        status: health.status === 'healthy' ? 'up' : 'down',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return { status: 'down', latencyMs: Date.now() - start, detail: (err as Error).message };
    }
  }

  private async checkRedis(): Promise<DependencyHealth> {
    const url = process.env.REDIS_URL;
    if (!url) {
      return { status: 'not_configured' };
    }

    const start = Date.now();
    const client = createClient({ url });
    try {
      await client.connect();
      await client.ping();
      return { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      return { status: 'down', latencyMs: Date.now() - start, detail: (err as Error).message };
    } finally {
      await client.quit().catch(() => undefined);
    }
  }

  async check(): Promise<DetailedHealth> {
    const [stellarRpc, redis] = await Promise.all([this.checkStellarRpc(), this.checkRedis()]);

    const degraded = stellarRpc.status === 'down' || redis.status === 'down';

    return {
      status: degraded ? 'degraded' : 'ok',
      dependencies: { stellarRpc, redis },
    };
  }
}
