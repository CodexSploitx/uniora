/**
 * Webhooks: where UNIORA sends the events that happen, and one delivery row per event per endpoint, each with its own retries. They
 * live in their OWN schema, `uniora_webhooks`, because the endpoint row holds the SIGNING SECRET (the worker needs it to sign): give
 * the role that serves organizations no access to it (see guides/sql/least-privilege-roles.sql).
 *
 * - `endpoints`: the URL, the event patterns, the organization filter (`all_organizations`, or a non-empty `organization_ids`), the
 *   status, a failure counter, and the current and previous secret (the previous one only signs until `previous_valid_until`, so a
 *   receiver can switch with no downtime).
 * - `deliveries`: pending, delivered or dead, claimed with a lease (`for update skip locked`) like the outbox. `id` is
 *   `<endpoint>:<event>`, so fanning the same event out twice cannot send it twice. They are deleted with their endpoint.
 * Every management change is audited in `uniora.audit_logs` (global entries) in the same transaction, without any secret.
 */
export const MIGRATION_0045_WEBHOOKS = `
create schema if not exists uniora_webhooks;

create table if not exists uniora_webhooks.endpoints (
  id text primary key check (length(id) between 1 and 200),
  url text not null check (length(url) between 1 and 2000),
  description text check (description is null or length(description) <= 200),
  events text[] not null check (cardinality(events) between 1 and 50),
  all_organizations boolean not null default true,
  organization_ids text[] not null default '{}' check (cardinality(organization_ids) <= 100),
  status text not null default 'enabled' check (status in ('enabled', 'disabled')),
  disabled_reason text check (disabled_reason is null or length(disabled_reason) <= 200),
  disabled_at timestamptz(3),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_success_at timestamptz(3),
  last_failure_at timestamptz(3),
  secret text not null check (secret ~ '^whsec_[A-Za-z0-9+/]{43}=$'),
  previous_secret text check (previous_secret is null or previous_secret ~ '^whsec_[A-Za-z0-9+/]{43}=$'),
  previous_valid_until timestamptz(3),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  updated_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  version integer not null default 1 check (version >= 1),
  check (all_organizations = (cardinality(organization_ids) = 0)),
  check ((previous_secret is null) = (previous_valid_until is null))
);
create index if not exists webhook_endpoints_status_idx on uniora_webhooks.endpoints (status, id);

create table if not exists uniora_webhooks.deliveries (
  seq bigint generated always as identity primary key,
  id text not null unique check (length(id) between 1 and 200),
  endpoint_id text not null references uniora_webhooks.endpoints (id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null check (length(event_type) between 1 and 120),
  organization_id text check (organization_id is null or length(organization_id) <= 200),
  event_created_at timestamptz(3) not null,
  payload jsonb check (payload is null or length(payload::text) <= 16384),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  available_at timestamptz(3) not null,
  locked_until timestamptz(3),
  delivered_at timestamptz(3),
  last_error text check (last_error is null or length(last_error) <= 600),
  last_http_status integer,
  last_duration_ms integer
);
create index if not exists webhook_deliveries_due_idx on uniora_webhooks.deliveries (available_at, seq) where status = 'pending';
create index if not exists webhook_deliveries_endpoint_idx on uniora_webhooks.deliveries (endpoint_id, seq desc);
create index if not exists webhook_deliveries_status_idx on uniora_webhooks.deliveries (status, seq desc);
`;
