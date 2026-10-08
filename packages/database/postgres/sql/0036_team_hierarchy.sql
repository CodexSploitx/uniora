-- @uniora/postgres migration 0036_team_hierarchy
-- Generated from src/migrations/0036_team_hierarchy.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Team hierarchy: a team can sit under another team of the SAME organization (a branch inside a region, a squad inside a
-- department). It is organizational only: nothing is inherited and the authorization engine never looks at it.
--
-- - `parent_id` references `teams (id, organization_id)` with the organization in the key, so a parent of another
--   organization is impossible in the database itself. The foreign key restricts: a team with sub-teams cannot be deleted.
-- - A team cannot be its own parent (check). Longer loops and the depth limit (8 levels) are checked by the repository
--   inside the transaction, under an advisory lock, because a recursive rule cannot be written as a constraint.

alter table uniora.teams add column if not exists parent_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'teams_parent_fk' and conrelid = 'uniora.teams'::regclass) then
    alter table uniora.teams
      add constraint teams_parent_fk foreign key (parent_id, organization_id) references uniora.teams (id, organization_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_parent_not_self' and conrelid = 'uniora.teams'::regclass) then
    alter table uniora.teams add constraint teams_parent_not_self check (parent_id is null or parent_id <> id);
  end if;
end
$$;

create index if not exists teams_parent_idx on uniora.teams (organization_id, parent_id);
