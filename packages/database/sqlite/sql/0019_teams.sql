-- @uniora/sqlite migration 0019_teams
-- Generated from src/migrations/0019_teams.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Teams (same model as `@uniora/postgres`'s `0034_teams`): organizational groups inside ONE organization and the
-- memberships that put organization members in them. Cross-tenant isolation is enforced by composite foreign keys that
-- include `organization_id`, so a row can never join a team of one organization to a member or a role of another.
-- `metadata` and `settings` are JSON objects stored as text; timestamps are ISO-8601 text.

create unique index if not exists uniora_memberships_id_org_idx on uniora_memberships (id, organization_id);
create unique index if not exists uniora_roles_id_org_idx on uniora_roles (id, organization_id);

create table if not exists uniora_teams (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora_organizations (id) on delete cascade,
  slug text not null check (length(slug) between 1 and 63),
  name text not null check (length(name) between 1 and 255),
  status text not null default 'active' check (status in ('active', 'archived')),
  external_id text check (external_id is null or length(external_id) between 1 and 200),
  metadata text not null default '{}' check (json_valid(metadata) and json_type(metadata) = 'object'),
  settings text not null default '{}' check (json_valid(settings) and json_type(settings) = 'object'),
  created_at text not null,
  updated_at text not null,
  archived_at text,
  archived_by_provider text,
  archived_by_subject text,
  archive_reason text,
  version integer not null default 1 check (version >= 1),
  unique (organization_id, slug),
  unique (id, organization_id),
  check ((status = 'archived') = (archived_at is not null))
);
create unique index if not exists uniora_teams_external_id_idx on uniora_teams (organization_id, external_id) where external_id is not null;
create index if not exists uniora_teams_org_idx on uniora_teams (organization_id, id);

create table if not exists uniora_team_memberships (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null,
  team_id text not null,
  membership_id text not null,
  status text not null check (status in ('pending', 'active', 'suspended', 'removed')),
  responsibility text not null default 'member' check (responsibility in ('owner', 'manager', 'member')),
  created_at text not null,
  updated_at text not null,
  joined_at text,
  invited_by_provider text,
  invited_by_subject text,
  status_changed_at text,
  status_changed_by_provider text,
  status_changed_by_subject text,
  status_reason text,
  version integer not null default 1 check (version >= 1),
  unique (team_id, membership_id),
  unique (id, organization_id),
  foreign key (team_id, organization_id) references uniora_teams (id, organization_id) on delete cascade,
  foreign key (membership_id, organization_id) references uniora_memberships (id, organization_id) on delete cascade
);
create index if not exists uniora_team_memberships_org_idx on uniora_team_memberships (organization_id, id);
create index if not exists uniora_team_memberships_member_idx on uniora_team_memberships (membership_id, status);
create index if not exists uniora_team_memberships_team_idx on uniora_team_memberships (team_id, status);

create table if not exists uniora_team_membership_roles (
  team_membership_id text not null,
  role_id text not null,
  organization_id text not null,
  primary key (team_membership_id, role_id),
  foreign key (team_membership_id, organization_id) references uniora_team_memberships (id, organization_id) on delete cascade,
  foreign key (role_id, organization_id) references uniora_roles (id, organization_id) on delete cascade
);
create index if not exists uniora_team_membership_roles_role_idx on uniora_team_membership_roles (role_id);
