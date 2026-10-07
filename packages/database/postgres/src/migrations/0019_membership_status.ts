/**
 * Membership status, dates and authorship.
 *
 * - `status` (`active` | `blocked`): a blocked member keeps their row and roles but the engine denies them
 *   everything. `blocked_at/by/reason` describe the CURRENT block and are all null while active (the audit log
 *   keeps the history); the check constraint ties them to `status` so they can't drift apart.
 * - `created_at`: since when the member belongs. Rows that existed before this migration get the time the migration
 *   ran — the real date was never recorded.
 * - `updated_at`: last change to the membership itself (roles assigned/removed, blocked/unblocked).
 * - `invited_by_*`: who invited the member, filled when the membership comes from an invitation.
 * - `last_active_at`: reported by the application (`recordActivity`); null until it does.
 */
export const MIGRATION_0019_MEMBERSHIP_STATUS = `
alter table uniora.memberships
  add column if not exists status text not null default 'active' check (status in ('active', 'blocked')),
  add column if not exists created_at timestamptz not null default date_trunc('milliseconds', now()),
  add column if not exists updated_at timestamptz not null default date_trunc('milliseconds', now()),
  add column if not exists invited_by_provider text,
  add column if not exists invited_by_subject text,
  add column if not exists last_active_at timestamptz,
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_by_provider text,
  add column if not exists blocked_by_subject text,
  add column if not exists block_reason text check (block_reason is null or length(block_reason) <= 500);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_block_consistent') then
    alter table uniora.memberships
      add constraint memberships_block_consistent check ((status = 'blocked') = (blocked_at is not null));
  end if;
end $$;

create index if not exists memberships_org_status_idx on uniora.memberships (organization_id, status, id);
`;
