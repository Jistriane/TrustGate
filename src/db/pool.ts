import { Pool } from 'pg';
import { loadDbConfig } from '../config/db';

let pool: Pool | undefined;

export function getDbPool(): Pool {
  if (!pool) {
    const config = loadDbConfig();
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

