/**
 * Team hierarchy (same model as `@uniora/postgres`'s `0036_team_hierarchy`): a team can sit under another team of the SAME
 * organization. Organizational only: nothing is inherited. SQLite cannot add a composite foreign key to an existing
 * table, so `parent_id` has a plain foreign key (a team with sub-teams cannot be deleted) and two triggers refuse a parent
 * of another organization on insert and update. Longer loops and the depth limit (8 levels) are checked by the repository.
 */
export const MIGRATION_0021_TEAM_HIERARCHY = `
alter table uniora_teams add column parent_id text references uniora_teams (id) check (parent_id is null or parent_id <> id);
create index if not exists uniora_teams_parent_idx on uniora_teams (organization_id, parent_id);

create trigger if not exists uniora_teams_parent_same_org_insert
before insert on uniora_teams
when new.parent_id is not null and not exists (select 1 from uniora_teams p where p.id = new.parent_id and p.organization_id = new.organization_id)
begin
  select raise(abort, 'team parent must belong to the same organization');
end;

create trigger if not exists uniora_teams_parent_same_org_update
before update of parent_id, organization_id on uniora_teams
when new.parent_id is not null and not exists (select 1 from uniora_teams p where p.id = new.parent_id and p.organization_id = new.organization_id)
begin
  select raise(abort, 'team parent must belong to the same organization');
end;
`;
