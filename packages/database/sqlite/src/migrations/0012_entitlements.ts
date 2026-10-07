/**
 * Entitlements: per-organization quotas (same model as `@uniora/postgres`'s `0027`): definitions with a reset period and
 * a default limit, an optional limit per organization (NULL = unlimited) and the usage of each window.
 */
export const MIGRATION_0012_ENTITLEMENTS = `
create table if not exists uniora_entitlement_definitions (
  key text primary key check (length(key) between 1 and 63),
  name text not null check (length(name) between 1 and 100),
  description text,
  period text not null default 'lifetime' check (period in ('lifetime', 'daily', 'monthly')),
  default_limit integer check (default_limit is null or default_limit >= 0)
);
create table if not exists uniora_entitlement_limits (
  organization_id text not null references uniora_organizations (id) on delete cascade,
  key text not null references uniora_entitlement_definitions (key) on delete cascade,
  limit_value integer check (limit_value is null or limit_value >= 0),
  updated_at text not null,
  primary key (organization_id, key)
);
create table if not exists uniora_entitlement_usage (
  organization_id text not null references uniora_organizations (id) on delete cascade,
  key text not null references uniora_entitlement_definitions (key) on delete cascade,
  window_start text not null,
  used integer not null default 0 check (used >= 0),
  primary key (organization_id, key, window_start)
);
create index if not exists uniora_entitlement_limits_key_idx on uniora_entitlement_limits (key);
create index if not exists uniora_entitlement_usage_key_idx on uniora_entitlement_usage (key);
`;
