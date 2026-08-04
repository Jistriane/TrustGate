create table if not exists event_consumptions (
  handler_name text not null,
  event_id uuid not null,
  stream_entry_id text,
  status text not null,
  attempts int not null default 0,
  last_error text,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (handler_name, event_id),
  constraint event_consumptions_status_check check (status in ('PROCESSING', 'SUCCEEDED', 'FAILED'))
);

create index if not exists event_consumptions_status_next_retry_idx on event_consumptions (status, next_retry_at);

