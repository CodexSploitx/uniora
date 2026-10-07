-- @uniora/postgres migration 0025_permission_groups_implications
-- Generated from src/migrations/0025_permission_groups_implications.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Permission groups and implied permissions.
--
-- - `permissions.group_key`: the catalog section a permission belongs to (for grouping in a role editor).
-- - `permission_implications (permission_key, implied_key)`: `permission_key` grants `implied_key` as well
--   (`appointments.write` implies `appointments.read`). Deleting a permission removes the rows where it is the
--   implier; the implied side is RESTRICTED, so a permission another one still implies can't be deleted by accident.
-- - `uniora.permission_implied_by(key)`: `key` plus every permission that implies it, transitively (at most 9 levels,
--   a cycle can't loop), used by `uniora.has_permission` so the SQL answers match the engine's.
--
-- `uniora.has_permission(org, key, provider, subject)` is redefined: a role passes when it holds `key` OR any
-- permission that implies it. Same security properties as `0021_rls_functions` (`security definer`, pinned `search_path`,
-- no dynamic SQL, never raises); the grants and the revoke from `public` are kept by `create or replace`.

alter table uniora.permissions add column if not exists group_key text check (group_key is null or length(group_key) <= 100);
create index if not exists permissions_group_key_idx on uniora.permissions (group_key, key);

create table if not exists uniora.permission_implications (
  permission_key text not null references uniora.permissions (key) on delete cascade,
  implied_key text not null references uniora.permissions (key) on delete restrict,
  primary key (permission_key, implied_key),
  check (permission_key <> implied_key)
);
create index if not exists permission_implications_implied_idx on uniora.permission_implications (implied_key);

create or replace function uniora.permission_implied_by(p_key text)
returns setof text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with recursive up(key, depth) as (
    select p_key, 0
    union
    select pi.permission_key, up.depth + 1
    from uniora.permission_implications pi
    join up on pi.implied_key = up.key
    where up.depth < 9
  )
  select distinct key from up
$$;

create or replace function uniora.has_permission(p_org text, p_key text, p_provider text, p_subject text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with membership as (
    select uniora.active_membership_id(p_org, p_provider, p_subject) as id
    where p_org is not null and p_provider is not null and p_subject is not null
      and p_key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$' and length(p_key) <= 150
  ),
  roles as (
    select r.is_owner_role, r.id
    from membership m
    join uniora.membership_roles mr on mr.membership_id = m.id
    join uniora.roles r on r.id = mr.role_id and r.organization_id = p_org
  )
  select coalesce(
    exists (
      select 1 from roles r
      join uniora.role_permissions rp on rp.role_id = r.id
      where rp.permission_key in (select uniora.permission_implied_by(p_key))
    )
    or (
      exists (select 1 from roles r where r.is_owner_role)
      and (
        coalesce(current_setting('uniora.owner_requires_registered_permission', true), '') <> 'on'
        or exists (select 1 from uniora.permissions p where p.key = p_key)
      )
    ),
    false)
$$;

revoke all on function uniora.permission_implied_by(text) from public;
