/**
 * Teams: organizational groups inside ONE organization, and the memberships that put organization members in them.
 *
 * - A team belongs to exactly one organization (`organization_id`, cascade on delete); `slug` and `external_id` are unique
 *   WITHIN the organization, never globally.
 * - Cross-tenant isolation is enforced by the database itself: a team membership references its team and its organization
 *   membership through composite keys that include `organization_id`, so a row can never join a team of one organization
 *   to a member of another (nor hold a role of a third). The composite keys need unique indexes on `(id, organization_id)`
 *   of the parent tables, added here.
 * - `status` of a team is `active` or `archived`; of a team membership `pending`, `active`, `suspended` or `removed` (the
 *   row stays when someone is removed). `responsibility` is a label (`owner`, `manager`, `member`), never a permission.
 * - Deleting a membership, a team or a role cleans the team memberships that depended on it.
 */
export const MIGRATION_0034_TEAMS = `
create unique index if not exists memberships_id_org_idx on uniora.memberships (id, organization_id);
create unique index if not exists roles_id_org_idx on uniora.roles (id, organization_id);

create table if not exists uniora.teams (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora.organizations (id) on delete cascade,
  slug text not null check (length(slug) between 1 and 63),
  name text not null check (length(name) between 1 and 255),
  status text not null default 'active' check (status in ('active', 'archived')),
  external_id text check (external_id is null or length(external_id) between 1 and 200),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by_provider text,
  archived_by_subject text,
  archive_reason text,
  version integer not null default 1 check (version >= 1),
  unique (organization_id, slug),
  unique (id, organization_id),
  check ((status = 'archived') = (archived_at is not null))
);
create unique index if not exists teams_external_id_idx on uniora.teams (organization_id, external_id) where external_id is not null;
create index if not exists teams_org_idx on uniora.teams (organization_id, id);

create table if not exists uniora.team_memberships (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null,
  team_id text not null,
  membership_id text not null,
  status text not null check (status in ('pending', 'active', 'suspended', 'removed')),
  responsibility text not null default 'member' check (responsibility in ('owner', 'manager', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  joined_at timestamptz,
  invited_by_provider text,
  invited_by_subject text,
  status_changed_at timestamptz,
  status_changed_by_provider text,
  status_changed_by_subject text,
  status_reason text,
  version integer not null default 1 check (version >= 1),
  unique (team_id, membership_id),
  unique (id, organization_id),
  foreign key (team_id, organization_id) references uniora.teams (id, organization_id) on delete cascade,
  foreign key (membership_id, organization_id) references uniora.memberships (id, organization_id) on delete cascade
);
create index if not exists team_memberships_org_idx on uniora.team_memberships (organization_id, id);
create index if not exists team_memberships_member_idx on uniora.team_memberships (membership_id, status);
create index if not exists team_memberships_team_idx on uniora.team_memberships (team_id, status);

create table if not exists uniora.team_membership_roles (
  team_membership_id text not null,
  role_id text not null,
  organization_id text not null,
  primary key (team_membership_id, role_id),
  foreign key (team_membership_id, organization_id) references uniora.team_memberships (id, organization_id) on delete cascade,
  foreign key (role_id, organization_id) references uniora.roles (id, organization_id) on delete cascade
);
create index if not exists team_membership_roles_role_idx on uniora.team_membership_roles (role_id);
`;
