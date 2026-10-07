-- @uniora/sqlite migration 0011_outbox
-- Generated from src/migrations/0011_outbox.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Transactional outbox (same model as `@uniora/postgres`'s `0026`): events written with the change that produced them,
-- delivered afterwards by `dispatchOutbox`. `seq` is the delivery order; `available_at` the retry time; `locked_until`
-- the lease of the worker that claimed it. No foreign key to organizations: an event outlives what it talks about.

create table if not exists uniora_outbox (
  seq integer primary key autoincrement,
  id text not null unique check (length(id) between 1 and 200),
  organization_id text,
  type text not null check (length(type) between 1 and 120),
  payload text check (payload is null or json_valid(payload)),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0,
  created_at text not null,
  available_at text not null,
  locked_until text,
  delivered_at text,
  last_error text
);
create index if not exists uniora_outbox_due_idx on uniora_outbox (available_at, seq) where status = 'pending';
create index if not exists uniora_outbox_status_idx on uniora_outbox (status, seq);
create index if not exists uniora_outbox_org_idx on uniora_outbox (organization_id, seq) where organization_id is not null;
create index if not exists uniora_outbox_delivered_idx on uniora_outbox (delivered_at) where status = 'delivered';
