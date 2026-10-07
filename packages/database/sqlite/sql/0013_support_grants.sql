-- @uniora/sqlite migration 0013_support_grants
-- Generated from src/migrations/0013_support_grants.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Support grants (same model as `@uniora/postgres`'s `0028`): temporary, narrow access for a platform operator who is not
-- a member. `permissions` is a JSON array of permission keys; a grant is active while `revoked_at` is null and
-- `expires_at` is in the future.

create table if not exists uniora_support_grants (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora_organizations (id) on delete cascade,
  operator_provider text not null,
  operator_subject text not null,
  granted_by_provider text not null,
  granted_by_subject text not null,
  reason text not null check (length(reason) between 1 and 500),
  permissions text not null check (json_valid(permissions) and json_array_length(permissions) between 1 and 50),
  created_at text not null,
  expires_at text not null,
  revoked_at text,
  revoked_by_provider text,
  revoked_by_subject text,
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_by_provider is null and revoked_by_subject is null))
);
create index if not exists uniora_support_grants_operator_idx on uniora_support_grants (organization_id, operator_provider, operator_subject, expires_at) where revoked_at is null;
create index if not exists uniora_support_grants_org_idx on uniora_support_grants (organization_id, id);
