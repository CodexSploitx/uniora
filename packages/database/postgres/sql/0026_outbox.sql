-- @uniora/postgres migration 0026_outbox
-- Generated from src/migrations/0026_outbox.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Transactional outbox: events written in the same transaction as the change that produced them, delivered by a worker
-- after commit (`dispatchOutbox`).
--
-- - `seq` is the delivery order (claims hand events out oldest first).
-- - `status`: `pending` (to deliver or retry), `delivered`, `dead` (gave up; `requeue` puts it back).
-- - `available_at` is the retry time; `locked_until` is the lease of a worker that claimed it (an event whose worker died
--   becomes claimable again when the lease expires). Claims use `for update skip locked`, so workers never block each other.
-- - There is deliberately no foreign key to `organizations`: an event outlives the entity it talks about.
-- - Times come from the application clock, like every other claim comparison, so one clock decides what is due.

create table if not exists uniora.outbox (
  seq bigint generated always as identity unique,
  id text primary key check (length(id) between 1 and 200),
  organization_id text,
  type text not null check (length(type) between 1 and 120),
  payload jsonb check (payload is null or jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  delivered_at timestamptz,
  last_error text
);
create index if not exists outbox_due_idx on uniora.outbox (available_at, seq) where status = 'pending';
create index if not exists outbox_status_idx on uniora.outbox (status, seq);
create index if not exists outbox_org_idx on uniora.outbox (organization_id, seq) where organization_id is not null;
create index if not exists outbox_delivered_idx on uniora.outbox (delivered_at) where status = 'delivered';
