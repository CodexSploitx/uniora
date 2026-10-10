/**
 * API credentials (same model as `@uniora/postgres`'s `0043_api_credentials`): who may call the UNIORA API server and with what
 * power, kept in `uniora_api_*` tables that no organization table references. SQLite has no schemas or per-table grants: keep
 * the credential storage out of code that serves organizations, or open this file with a separate connection for it.
 *
 * - `uniora_api_clients`: a named machine principal with scopes and an organization allowlist (`all_organizations`, or a
 *   non-empty `organization_ids`; never both, never neither). Names are unique ignoring case and spacing (`name_normalized`).
 * - `uniora_api_keys`: only the SHA-256 of a key's secret is stored (`secret_hash`), never the secret. At most two keys of a
 *   client are active at once; the repository decides that inside a `begin immediate` transaction, so nothing can slip
 *   past it. A key's id is the public part embedded in the key itself.
 */
export const MIGRATION_0028_API_CREDENTIALS = `
create table if not exists uniora_api_clients (
  id text primary key check (length(id) between 1 and 200),
  name text not null check (length(name) between 1 and 100),
  name_normalized text not null unique check (length(name_normalized) between 1 and 100),
  scopes text not null check (json_valid(scopes) and json_type(scopes) = 'array' and json_array_length(scopes) between 1 and 20),
  all_organizations integer not null default 0 check (all_organizations in (0, 1)),
  organization_ids text not null default '[]' check (json_valid(organization_ids) and json_type(organization_ids) = 'array' and json_array_length(organization_ids) <= 500),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at text not null,
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  updated_at text not null,
  version integer not null default 1 check (version >= 1),
  check (all_organizations = (json_array_length(organization_ids) = 0))
);
create index if not exists uniora_api_clients_status_idx on uniora_api_clients (status, id);

create table if not exists uniora_api_keys (
  id text primary key check (length(id) = 16 and id not glob '*[^0-9A-Za-z]*'),
  client_id text not null references uniora_api_clients (id) on delete restrict,
  secret_hash text not null check (length(secret_hash) = 64 and secret_hash not glob '*[^0-9a-f]*'),
  hint text not null check (length(hint) = 4),
  created_at text not null,
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  expires_at text,
  revoked_at text,
  revoked_by_provider text,
  revoked_by_subject text,
  last_used_at text,
  check ((revoked_at is null) = (revoked_by_provider is null and revoked_by_subject is null))
);
create index if not exists uniora_api_keys_client_idx on uniora_api_keys (client_id, created_at desc, id);
`;
