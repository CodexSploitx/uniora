-- @uniora/postgres migration 0043_api_credentials
-- Generated from src/migrations/0043_api_credentials.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- API credentials: who may call the UNIORA API server and with what power. Like the platform, they live in their OWN schema,
-- `uniora_api`, so the database keeps them apart from organization data: give the role that serves organizations no access
-- to it (see guides/sql/least-privilege-roles.sql) and a bug or injection there cannot read or mint keys. The API server
-- itself needs to read `clients` and `keys` and update `keys.last_used_at`, and nothing else in this schema.
--
-- - `clients`: a named machine principal with scopes and an organization allowlist (`all_organizations`, or a non-empty
--   `organization_ids`; never both, never neither). Names are unique ignoring case and spacing (`name_normalized`).
-- - `keys`: only the SHA-256 of a key's secret is stored (`secret_hash`), never the secret. At most two keys of a client are
--   active at once; that cap is decided by the repository under a lock on the client row, in the same transaction as the insert.
--   A key's id is the public part embedded in the key itself.
-- Every change is audited in `uniora.audit_logs` (global entries) in the same transaction, without any secret.

create schema if not exists uniora_api;

create table if not exists uniora_api.clients (
  id text primary key check (length(id) between 1 and 200),
  name text not null check (length(name) between 1 and 100),
  name_normalized text not null unique check (length(name_normalized) between 1 and 100),
  scopes text[] not null check (cardinality(scopes) between 1 and 20),
  all_organizations boolean not null default false,
  organization_ids text[] not null default '{}' check (cardinality(organization_ids) <= 500),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  updated_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  version integer not null default 1 check (version >= 1),
  check (all_organizations = (cardinality(organization_ids) = 0))
);
create index if not exists api_clients_status_idx on uniora_api.clients (status, id);

create table if not exists uniora_api.keys (
  id text primary key check (id ~ '^[0-9A-Za-z]{16}$'),
  client_id text not null references uniora_api.clients (id) on delete restrict,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  hint text not null check (length(hint) = 4),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  expires_at timestamptz(3),
  revoked_at timestamptz(3),
  revoked_by_provider text,
  revoked_by_subject text,
  last_used_at timestamptz(3),
  check ((revoked_at is null) = (revoked_by_provider is null and revoked_by_subject is null))
);
create index if not exists api_keys_client_idx on uniora_api.keys (client_id, created_at desc, id);
