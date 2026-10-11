-- @uniora/sqlite migration 0020_invitation_teams
-- Generated from src/migrations/0020_invitation_teams.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Teams on invitations (same model as `@uniora/postgres`'s `0035_invitation_teams`): an invitation can offer team
-- membership of the same organization, granted only when the invitation is accepted. The composite key to
-- `uniora_teams (id, organization_id)` rules out a team of another organization; deleting the team or the invitation
-- removes the offer.

create table if not exists uniora_invitation_teams (
  invitation_id text not null references uniora_invitations (id) on delete cascade,
  organization_id text not null,
  team_id text not null,
  primary key (invitation_id, team_id),
  foreign key (team_id, organization_id) references uniora_teams (id, organization_id) on delete cascade
);
create index if not exists uniora_invitation_teams_team_idx on uniora_invitation_teams (team_id);
