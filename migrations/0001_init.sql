create extension if not exists pgcrypto;

create table if not exists executors (
  public_key text primary key,
  metadata_uri text,
  registered_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key,
  requester_public_key text not null,
  reserve_price_stroops bigint not null,
  description text not null,
  deadline timestamptz not null,
  status text not null,
  selected_bid_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_status_check check (status in ('OPEN', 'ASSIGNED', 'COMPLETED', 'EXPIRED'))
);

create index if not exists tasks_status_created_at_idx on tasks (status, created_at desc);
create index if not exists tasks_requester_created_at_idx on tasks (requester_public_key, created_at desc);

create table if not exists bids (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  executor_public_key text not null,
  amount_stroops bigint not null,
  collateral_stroops bigint not null,
  escrow_id text not null,
  status text not null,
  created_at timestamptz not null default now(),
  constraint bids_status_check check (status in ('PENDING', 'SELECTED', 'REJECTED'))
);

create index if not exists bids_task_amount_idx on bids (task_id, amount_stroops asc);
create index if not exists bids_task_status_idx on bids (task_id, status);

create table if not exists task_results (
  task_id uuid primary key references tasks(id) on delete cascade,
  payload_json jsonb not null,
  payload_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists idempotency_keys (
  key text primary key,
  scope text not null,
  public_key text,
  request_hash text not null,
  response_code int not null,
  response_body jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idempotency_scope_pk_created_at_idx on idempotency_keys (scope, public_key, created_at desc);

create table if not exists outbox_events (
  id uuid primary key,
  type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text
);

create index if not exists outbox_processed_created_at_idx on outbox_events (processed_at, created_at);

