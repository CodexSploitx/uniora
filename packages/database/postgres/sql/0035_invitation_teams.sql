-- @uniora/postgres migration 0035_invitation_teams
-- Generated from src/migrations/0035_invitation_teams.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Teams on invitations: an invitation can offer the invitee membership of one or more teams of the same organization,
-- granted when (and only when) the invitation is accepted. `invitation_teams` holds the offer. Its composite key to
-- `teams (id, organization_id)` makes it impossible to offer a team of another organization, and deleting the team (or
-- the invitation) removes the offer. The offer itself grants nothing: the service re-checks that the inviter may still
-- add people to each team at accept time.

create table if not exists uniora.invitation_teams (
  invitation_id text not null references uniora.invitations (id) on delete cascade,
  organization_id text not null,
  team_id text not null,
  primary key (invitation_id, team_id),
  foreign key (team_id, organization_id) references uniora.teams (id, organization_id) on delete cascade
);
create index if not exists invitation_teams_team_idx on uniora.invitation_teams (team_id);
