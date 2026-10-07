-- @uniora/postgres migration 0028_support_grants
-- Generated from src/migrations/0028_support_grants.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Support grants: temporary, narrow access for a platform operator who is not a member of an organization.
--
-- - `permissions` is the explicit list of keys the grant allows (1 to 50); there is no wildcard and no Owner role.
-- - A grant is active while `revoked_at` is null and `expires_at` is in the future; it can't outlive 30 days (checked by
--   the library; the table only requires `expires_at > created_at`).
-- - Who asked (`granted_by_*`) and who ended it (`revoked_by_*`) are kept on the row; the audit log keeps the history.
-- The SQL functions for row-level security deliberately ignore grants: operators act through trusted server code.

create table if not exists uniora.support_grants (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora.organizations (id) on delete cascade,
  operator_provider text not null,
  operator_subject text not null,
  granted_by_provider text not null,
  granted_by_subject text not null,
  reason text not null check (length(reason) between 1 and 500),
  permissions text[] not null check (cardinality(permissions) between 1 and 50),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_provider text,
  revoked_by_subject text,
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_by_provider is null and revoked_by_subject is null))
);
create index if not exists support_grants_operator_idx on uniora.support_grants (organization_id, operator_provider, operator_subject, expires_at) where revoked_at is null;
create index if not exists support_grants_org_idx on uniora.support_grants (organization_id, id);
