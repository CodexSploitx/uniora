/**
 * Entitlements: per-organization quotas (`seats`, `vehicles`, `reports_per_month`).
 *
 * - `entitlement_definitions`: the quantity itself, its reset `period` (lifetime / daily / monthly, UTC) and the
 *   `default_limit` an organization gets without an override (NULL = unlimited).
 * - `entitlement_limits`: one organization's own limit (`limit_value` NULL = unlimited for it). No row = follow the default.
 * - `entitlement_usage`: how much was taken in each window; `consume` is one atomic upsert, so concurrent requests can't
 *   both slip under the limit.
 * Deleting a definition or an organization removes their rows. UNIORA knows nothing about plans or licences: the host sets limits.
 */
export const MIGRATION_0027_ENTITLEMENTS = `
create table if not exists uniora.entitlement_definitions (
  key text primary key check (length(key) between 1 and 63 and key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  name text not null check (length(name) between 1 and 100),
  description text,
  period text not null default 'lifetime' check (period in ('lifetime', 'daily', 'monthly')),
  default_limit bigint check (default_limit is null or default_limit >= 0)
);
create table if not exists uniora.entitlement_limits (
  organization_id text not null references uniora.organizations (id) on delete cascade,
  key text not null references uniora.entitlement_definitions (key) on delete cascade,
  limit_value bigint check (limit_value is null or limit_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, key)
);
create table if not exists uniora.entitlement_usage (
  organization_id text not null references uniora.organizations (id) on delete cascade,
  key text not null references uniora.entitlement_definitions (key) on delete cascade,
  window_start timestamptz not null,
  used bigint not null default 0 check (used >= 0),
  primary key (organization_id, key, window_start)
);
create index if not exists entitlement_limits_key_idx on uniora.entitlement_limits (key);
create index if not exists entitlement_usage_key_idx on uniora.entitlement_usage (key);
`;
