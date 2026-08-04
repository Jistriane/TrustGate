import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const res = await pool.query<{ id: string }>('select id from schema_migrations');
  return new Set(res.rows.map((r) => r.id));
}

export async function runMigrations(pool: Pool, migrationsDir: string): Promise<MigrationResult> {
  await ensureMigrationsTable(pool);
  const applied = await getAppliedMigrations(pool);

  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();

  const newlyApplied: string[] = [];
  for (const file of sqlFiles) {
    if (applied.has(file)) continue;

    const sqlPath = path.join(migrationsDir, file);
    const sql = await readFile(sqlPath, 'utf8');

    await pool.query('begin');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (id) values ($1)', [file]);
      await pool.query('commit');
    } catch (err) {
      await pool.query('rollback');
      throw err;
    }

    newlyApplied.push(file);
  }

  return { applied: newlyApplied };
}

