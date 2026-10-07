/**
 * Functions for the application's own row-level-security policies.
 *
 *   create policy "members read" on public.vehicles for select using (uniora.is_member(organization_id));
 *   create policy "editors write" on public.vehicles for update using (uniora.has_permission(organization_id, 'vehicles.update'));
 *   create policy "feature on"   on public.reports  for select using (uniora.is_feature_enabled(organization_id, 'advanced_reports'));
 *
 * They answer EXACTLY what the TypeScript engine answers (same rules, so a policy and `engine.can()` can't disagree):
 * only ACTIVE memberships count (a blocked member is denied everything, Owner included), an identity linked to
 * another resolves to it, the Owner role passes any well-formed permission key, features use the organization's
 * override, else the default, and every parent must be on.
 *
 * Security:
 * - `security definer`, so the caller's role needs no access to the `uniora` tables at all; `search_path` is pinned to
 *   `pg_catalog, pg_temp` and every object is schema-qualified, so a caller can't shadow anything.
 * - `stable`, so Postgres evaluates them once per statement/row group, not per column.
 * - They take no table-name or SQL text, only values, and never raise on malformed input (they answer `false`).
 * - EXECUTE is revoked from `public`: grant it on purpose to the roles your policies run as
 *   (see guides/rls.md). The three-argument forms take an explicit identity and are meant for trusted server code;
 *   do not grant them to roles that end users control.
 *
 * Who is "the current user": `uniora.current_identity()` reads the transaction-local settings `uniora.identity_provider`
 * and `uniora.identity_subject` (set by your server with `select set_config('uniora.identity_provider', 'supabase', true)`).
 * To derive it from your auth layer instead (e.g. Supabase `auth.uid()`), `create or replace` that one function.
 *
 * `uniora.owner_requires_registered_permission = 'on'` (e.g. `alter database ... set`) mirrors the engine option of the
 * same name: the Owner then only passes permission keys registered in the catalog.
 */
export const MIGRATION_0021_RLS_FUNCTIONS = `
create or replace function uniora.current_identity()
returns table (provider text, subject text)
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(current_setting('uniora.identity_provider', true), ''),
         nullif(current_setting('uniora.identity_subject', true), '')
  where nullif(current_setting('uniora.identity_provider', true), '') is not null
    and nullif(current_setting('uniora.identity_subject', true), '') is not null
$$;

-- The active membership of an identity in an organization, resolving a link from an alias identity (same lookup
-- as MembershipRepository.findByIdentity). Internal: not granted to anyone.
create or replace function uniora.active_membership_id(p_org text, p_provider text, p_subject text)
returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select m.id
  from uniora.memberships m
  where m.organization_id = p_org
    and m.status = 'active'
    and (
      (m.provider = p_provider and m.subject = p_subject)
      or exists (
        select 1 from uniora.identity_links il
        where il.from_provider = p_provider and il.from_subject = p_subject
          and il.to_provider = m.provider and il.to_subject = m.subject
      )
    )
  limit 1
$$;

create or replace function uniora.is_member(p_org text, p_provider text, p_subject text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    p_org is not null and p_provider is not null and p_subject is not null
    and uniora.active_membership_id(p_org, p_provider, p_subject) is not null,
    false)
$$;

create or replace function uniora.is_member(p_org text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select uniora.is_member(p_org, i.provider, i.subject) from uniora.current_identity() i), false)
$$;

create or replace function uniora.has_permission(p_org text, p_key text, p_provider text, p_subject text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with membership as (
    select uniora.active_membership_id(p_org, p_provider, p_subject) as id
    where p_org is not null and p_provider is not null and p_subject is not null
      and p_key ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$' and length(p_key) <= 150
  ),
  roles as (
    select r.is_owner_role, r.id
    from membership m
    join uniora.membership_roles mr on mr.membership_id = m.id
    join uniora.roles r on r.id = mr.role_id and r.organization_id = p_org
  )
  select coalesce(
    exists (select 1 from roles r join uniora.role_permissions rp on rp.role_id = r.id where rp.permission_key = p_key)
    or (
      exists (select 1 from roles r where r.is_owner_role)
      and (
        coalesce(current_setting('uniora.owner_requires_registered_permission', true), '') <> 'on'
        or exists (select 1 from uniora.permissions p where p.key = p_key)
      )
    ),
    false)
$$;

create or replace function uniora.has_permission(p_org text, p_key text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select uniora.has_permission(p_org, p_key, i.provider, i.subject) from uniora.current_identity() i), false)
$$;

-- Effective state of a feature for an organization: the organization's override, else the feature's default, and
-- every ancestor must be on too. Unknown feature, unknown parent or a chain deeper than 8 levels: false.
create or replace function uniora.is_feature_enabled(p_org text, p_key text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with recursive chain(key, parent_key, own_state, depth) as (
    select d.key, d.parent_key, coalesce(f.enabled, d.default_enabled), 1
    from uniora.feature_definitions d
    left join uniora.features f on f.organization_id = p_org and f.key = d.key
    where d.key = p_key
    union all
    select d.key, d.parent_key, coalesce(f.enabled, d.default_enabled), c.depth + 1
    from chain c
    join uniora.feature_definitions d on d.key = c.parent_key
    left join uniora.features f on f.organization_id = p_org and f.key = d.key
    where c.depth < 9
  )
  select coalesce(
    p_org is not null
    and exists (select 1 from chain)
    and bool_and(own_state)
    and bool_and(parent_key is null) filter (where depth = (select max(depth) from chain)),
    false)
  from chain
$$;

-- Permission AND/OR feature in one call, like AuthorizationEngine.access.check(): every argument given must hold, and
-- when neither is given the caller must simply be an active member.
create or replace function uniora.has_access(p_org text, p_permission text default null, p_feature text default null)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_permission is null and p_feature is null then uniora.is_member(p_org)
    else (p_permission is null or uniora.has_permission(p_org, p_permission))
     and (p_feature is null or (uniora.is_member(p_org) and uniora.is_feature_enabled(p_org, p_feature)))
  end
$$;

revoke all on function uniora.current_identity() from public;
revoke all on function uniora.active_membership_id(text, text, text) from public;
revoke all on function uniora.is_member(text, text, text) from public;
revoke all on function uniora.is_member(text) from public;
revoke all on function uniora.has_permission(text, text, text, text) from public;
revoke all on function uniora.has_permission(text, text) from public;
revoke all on function uniora.is_feature_enabled(text, text) from public;
revoke all on function uniora.has_access(text, text, text) from public;
`;
