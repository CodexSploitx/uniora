-- @uniora/postgres migration 0048_rls_team_functions
-- Generated from src/migrations/0048_rls_team_functions.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Row-level security by team: `uniora.is_team_member` and `uniora.is_team_manager` answer, inside the database, what the engine
-- reads as `subject.teamIds` and `subject.managedTeamIds` (the teams the person leads: responsibility `owner` or `manager`),
-- so a policy on your own table can say "only the members of this row's team see it":
--
--   create policy "team reads" on public.documents
--     for select using (uniora.is_team_member(organization_id, team_id));
--
-- - `is_team_member(org, team)` uses `uniora.current_identity()`; `is_team_member(org, team, provider, subject)` is for trusted
--   server code that checks someone other than the caller (do not grant it to roles an end user controls).
-- - True only for an ACTIVE member of an ACTIVE team of an organization the person is a current member of: it starts from
--   `uniora.active_membership_id`, the function `is_member` uses, so a blocked or suspended member, a suspended or archived
--   organization and an identity alias are decided exactly as there. Everything unknown (a team of another organization, a
--   `NULL`, no identity) is `false`; it never raises and never returns `NULL`.
-- - Like the other functions: `security definer` with a pinned `search_path`, `stable`, EXECUTE revoked from `public`. The caller's
--   role needs no access to the `uniora` tables; grant EXECUTE to the roles your policies run as.
-- - It does not cap the number of teams the way the engine does (more than `MAX_SUBJECT_TEAMS` makes `subject.teamIds` unknown there).
--
-- Additive: it changes no existing function or table, and needs no new index (`team_memberships` is unique on `(team_id, membership_id)`).

create or replace function uniora.is_team_member(p_org text, p_team text, p_provider text, p_subject text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    p_org is not null and p_team is not null and p_provider is not null and p_subject is not null
    and exists (
      select 1
      from uniora.team_memberships tm
      join uniora.teams t on t.id = tm.team_id and t.organization_id = tm.organization_id
      where tm.organization_id = p_org and tm.team_id = p_team
        and tm.membership_id = uniora.active_membership_id(p_org, p_provider, p_subject)
        and tm.status = 'active' and t.status = 'active'),
    false)
$$;

create or replace function uniora.is_team_member(p_org text, p_team text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select uniora.is_team_member(p_org, p_team, i.provider, i.subject) from uniora.current_identity() i), false)
$$;

create or replace function uniora.is_team_manager(p_org text, p_team text, p_provider text, p_subject text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    p_org is not null and p_team is not null and p_provider is not null and p_subject is not null
    and exists (
      select 1
      from uniora.team_memberships tm
      join uniora.teams t on t.id = tm.team_id and t.organization_id = tm.organization_id
      where tm.organization_id = p_org and tm.team_id = p_team
        and tm.membership_id = uniora.active_membership_id(p_org, p_provider, p_subject)
        and tm.status = 'active' and t.status = 'active'
        and tm.responsibility in ('owner', 'manager')),
    false)
$$;

create or replace function uniora.is_team_manager(p_org text, p_team text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select uniora.is_team_manager(p_org, p_team, i.provider, i.subject) from uniora.current_identity() i), false)
$$;

revoke all on function uniora.is_team_member(text, text, text, text) from public;
revoke all on function uniora.is_team_member(text, text) from public;
revoke all on function uniora.is_team_manager(text, text, text, text) from public;
revoke all on function uniora.is_team_manager(text, text) from public;
