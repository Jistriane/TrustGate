import 'dotenv/config';
import path from 'path';
import { getDbPool, closeDbPool } from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';

async function main(): Promise<void> {
  const pool = getDbPool();
  const dir = path.resolve(__dirname, '../migrations');
  const result = await runMigrations(pool, dir);
  if (result.applied.length > 0) {
    console.log(`Applied migrations: ${result.applied.join(', ')}`);
  } else {
    console.log('No migrations to apply');
  }
  await closeDbPool();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

