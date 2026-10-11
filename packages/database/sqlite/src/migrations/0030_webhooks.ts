/**
 * Webhooks (same model as `@uniora/postgres`'s `0045_webhooks`): where UNIORA sends the events that happen, and one delivery row per
 * event per endpoint, each with its own retries. Kept in `uniora_webhook_*` tables that no organization table references: the
 * endpoint row holds the SIGNING SECRET (the worker needs it to sign), so open this file with a separate connection for the webhook
 * storage when you can, and keep it out of code that serves organizations.
 *
 * - `uniora_webhook_endpoints`: the URL, the event patterns, the organization filter (`all_organizations`, or a non-empty
 *   `organization_ids`), the status, a failure counter, and the current and previous secret (the previous one only signs until
 *   `previous_valid_until`, so a receiver can switch with no downtime).
 * - `uniora_webhook_deliveries`: pending, delivered or dead, claimed with a lease like the outbox. `id` is `<endpoint>:<event>`, so
 *   fanning the same event out twice cannot send it twice. They are deleted with their endpoint.
 */
export const MIGRATION_0030_WEBHOOKS = `
create table if not exists uniora_webhook_endpoints (
  id text primary key check (length(id) between 1 and 200),
  url text not null check (length(url) between 1 and 2000),
  description text check (description is null or length(description) <= 200),
  events text not null check (json_valid(events) and json_type(events) = 'array' and json_array_length(events) between 1 and 50),
  all_organizations integer not null default 1 check (all_organizations in (0, 1)),
  organization_ids text not null default '[]' check (json_valid(organization_ids) and json_type(organization_ids) = 'array' and json_array_length(organization_ids) <= 100),
  status text not null default 'enabled' check (status in ('enabled', 'disabled')),
  disabled_reason text check (disabled_reason is null or length(disabled_reason) <= 200),
  disabled_at text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_success_at text,
  last_failure_at text,
  secret text not null check (length(secret) = 50 and substr(secret, 1, 6) = 'whsec_'),
  previous_secret text check (previous_secret is null or (length(previous_secret) = 50 and substr(previous_secret, 1, 6) = 'whsec_')),
  previous_valid_until text,
  created_at text not null,
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  updated_at text not null,
  version integer not null default 1 check (version >= 1),
  check (all_organizations = (json_array_length(organization_ids) = 0)),
  check ((previous_secret is null) = (previous_valid_until is null))
);
create index if not exists uniora_webhook_endpoints_status_idx on uniora_webhook_endpoints (status, id);

create table if not exists uniora_webhook_deliveries (
  seq integer primary key autoincrement,
  id text not null unique check (length(id) between 1 and 200),
  endpoint_id text not null references uniora_webhook_endpoints (id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null check (length(event_type) between 1 and 120),
  organization_id text check (organization_id is null or length(organization_id) <= 200),
  event_created_at text not null,
  payload text check (payload is null or (json_valid(payload) and length(payload) <= 16384)),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at text not null,
  available_at text not null,
  locked_until text,
  delivered_at text,
  last_error text check (last_error is null or length(last_error) <= 600),
  last_http_status integer,
  last_duration_ms integer
);
create index if not exists uniora_webhook_deliveries_due_idx on uniora_webhook_deliveries (available_at, seq) where status = 'pending';
create index if not exists uniora_webhook_deliveries_endpoint_idx on uniora_webhook_deliveries (endpoint_id, seq desc);
create index if not exists uniora_webhook_deliveries_status_idx on uniora_webhook_deliveries (status, seq desc);
`;
