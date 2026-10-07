-- @uniora/sqlite migration 0005_membership_status
-- Generated from src/migrations/0005_membership_status.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Membership status, dates and authorship — same model as `@uniora/postgres`'s `0019_membership_status`.
--
-- `status` (`active` | `blocked`), the current block's `blocked_at/by/reason` (all null while active; the audit log keeps
-- the history), `created_at` (rows that existed before this migration get the time it ran — the real date was never
-- recorded), `updated_at`, `invited_by_*` and the application-reported `last_active_at`.

alter table uniora_memberships add column status text not null default 'active' check (status in ('active', 'blocked'));
alter table uniora_memberships add column created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
alter table uniora_memberships add column updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
alter table uniora_memberships add column invited_by_provider text;
alter table uniora_memberships add column invited_by_subject text;
alter table uniora_memberships add column last_active_at text;
alter table uniora_memberships add column blocked_at text;
alter table uniora_memberships add column blocked_by_provider text;
alter table uniora_memberships add column blocked_by_subject text;
alter table uniora_memberships add column block_reason text check (block_reason is null or length(block_reason) <= 500);
create index if not exists uniora_memberships_org_status_idx on uniora_memberships (organization_id, status, id);
