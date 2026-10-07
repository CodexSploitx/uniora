-- @uniora/postgres migration 0002_audit_logs
-- Generated from src/migrations/0002_audit_logs.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Audit log table (docs/PROYECT.md §31, security skill §26). Deliberately
-- NOT `on delete cascade` on `organization_id`: unlike every other
-- `uniora.*` table, an audit trail must not silently disappear if its
-- organization is ever deleted — that would erase the only record of what
-- happened (including the deletion itself). There is no delete-organization
-- operation in Core yet; when one is added, it must decide explicitly how
-- to handle organizations with audit history instead of cascading it away.

create table if not exists uniora.audit_logs (
  id text primary key,
  organization_id text not null references uniora.organizations(id),
  actor_provider text not null,
  actor_subject text not null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_organization_id_created_at_idx
  on uniora.audit_logs (organization_id, created_at desc);
