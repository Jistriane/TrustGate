-- =============================================================================
-- Migration 0004 — Scalability indexes for TimeoutService dual-pass cron
-- Date: 2026-08-06
-- Author: TrustGate Architecture
--
-- Context: ADR 0006 §1.2 item 6.2 — parameterized DB-side queries avoid
-- full table scan in worker.cron */5 min (P0 worker).
--
-- Expected impact on tables > 10k rows:
--   TimeoutService.runOnce(): O(N log N) → O(log N) (via idx_tasks_status_deadline)
--   TimeoutService.runClaimTimeoutPass(): O(N log N) → O(log N) (via idx_bids_status_created_at)
--
-- Plan B: If there's lock contention in mass deployment (peak hours):
--   1. Run manually outside a transaction with CONCURRENTLY via psql shell.
--   2. Then manually insert the row into schema_migrations:
--        insert into schema_migrations (id) values ('0004_create_indexes.sql');
--   3. Don't re-run this migration — IF NOT EXISTS guarantees idempotency.
-- =============================================================================

-- tasks: composite index for runOnce() query: WHERE status='ASSIGNED' AND deadline < $1
create index if not exists idx_tasks_status_deadline
  on tasks (status, deadline asc);

-- tasks: descending index for recent listing "last published tasks" in API.
create index if not exists idx_tasks_created_at
  on tasks (created_at desc);

-- bids: composite index for runClaimTimeoutPass() query:
--   WHERE status='SELECTED' AND created_at <= cutoff ORDER BY created_at asc
create index if not exists idx_bids_status_created_at
  on bids (status, created_at asc);

-- bids: index by task_id for frequent joins "all bids for a task".
create index if not exists idx_bids_task_id_created_at
  on bids (task_id, created_at asc);

-- (optional, commented out by default: if outbox grows > 50k rows, enable:)
-- create index if not exists idx_outbox_processed_created_at
--   on outbox (processed, created_at asc);
-- create index if not exists idx_idempotency_key_expires_at
--   on idempotency (key, expires_at desc);
