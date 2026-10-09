/**
 * Policies (same model as `@uniora/postgres`'s `0040_policies`): declarative rules that only ever RESTRICT what the role-based
 * engine allows (see guides/policies.md).
 *
 * - `uniora_policies`: one organization each (cascade on delete); `key` is unique within the organization for all time; `kind`
 *   and `effect` are derived from the definition and a check keeps them in agreement. `definition` is JSON text.
 * - `uniora_policy_revisions`: every definition the policy ever had, immutable (triggers refuse UPDATE, and DELETE unless the
 *   policy itself is gone). The policy row points at its current revision through a deferred composite key
 *   `(policy_id, organization_id, revision, definition_hash)`, so a revision of one organization can never belong to a policy of
 *   another, and a policy cannot exist without its current revision. Triggers check the definition on the policy row is the
 *   one in that revision, in both directions (a revision is inserted before the policy points at it, or right after the policy
 *   is created).
 * - Lifecycle triggers: retired is terminal, only legal moves are accepted, `activated_at` is set once, a policy that was ever
 *   active cannot be deleted (unless its organization is), `version` goes up by exactly one per change.
 * - Limits: 1000 policies per organization, 200 active (keep in sync with MAX_POLICIES_PER_ORGANIZATION and MAX_ACTIVE_POLICIES in
 *   @uniora/core), 1000 revisions per policy.
 * - `uniora_policy_set_revisions`: one counter per organization, bumped on every change to any of its policies (the engine caches
 *   the active set by it).
 */
export const MIGRATION_0025_POLICIES = `
create table if not exists uniora_policies (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora_organizations (id) on delete cascade,
  key text not null check (
    length(key) between 1 and 100 and key not glob '*[^a-z0-9._-]*' and key glob '[a-z0-9]*' and key glob '*[a-z0-9]' and key not glob '*[._-][._-]*'),
  name text not null check (length(name) between 1 and 255),
  description text check (description is null or length(description) between 1 and 1000),
  kind text not null check (kind in ('access', 'resource', 'scope', 'feature')),
  effect text not null check (effect in ('deny', 'require')),
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled', 'retired')),
  revision integer not null default 1 check (revision >= 1),
  definition text not null check (json_valid(definition) and json_type(definition) = 'object' and length(cast(definition as blob)) <= 16384),
  definition_hash text not null check (length(definition_hash) = 64 and definition_hash not glob '*[^0-9a-f]*'),
  created_at text not null,
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  updated_at text not null,
  activated_at text,
  status_changed_at text,
  status_changed_by_provider text,
  status_changed_by_subject text,
  status_reason text check (status_reason is null or length(status_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  unique (organization_id, key),
  unique (id, organization_id),
  check (kind = json_extract(definition, '$.kind') and effect = json_extract(definition, '$.effect')),
  check ((status = 'draft') = (activated_at is null)),
  check ((status_changed_at is null) = (status_changed_by_provider is null) and (status_changed_at is null) = (status_changed_by_subject is null)),
  foreign key (id, organization_id, revision, definition_hash)
    references uniora_policy_revisions (policy_id, organization_id, revision, definition_hash) deferrable initially deferred
);
create index if not exists uniora_policies_org_idx on uniora_policies (organization_id, id);
create index if not exists uniora_policies_active_idx on uniora_policies (organization_id, id) where status = 'active';

create table if not exists uniora_policy_revisions (
  policy_id text not null,
  organization_id text not null,
  revision integer not null check (revision >= 1),
  definition text not null check (json_valid(definition) and json_type(definition) = 'object' and length(cast(definition as blob)) <= 16384),
  definition_hash text not null check (length(definition_hash) = 64 and definition_hash not glob '*[^0-9a-f]*'),
  created_at text not null,
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  note text check (note is null or length(note) between 1 and 500),
  primary key (policy_id, revision),
  unique (policy_id, organization_id, revision, definition_hash),
  foreign key (policy_id, organization_id) references uniora_policies (id, organization_id) on delete cascade deferrable initially deferred
);

create table if not exists uniora_policy_set_revisions (
  organization_id text primary key references uniora_organizations (id) on delete cascade,
  revision integer not null default 0 check (revision >= 0)
);

create trigger if not exists uniora_policies_guard_insert
before insert on uniora_policies
when new.status <> 'draft' or new.revision <> 1 or new.version <> 1
begin
  select raise(abort, 'policy_immutable: a policy is created as draft, revision 1, version 1');
end;

create trigger if not exists uniora_policies_limit_insert
before insert on uniora_policies
when (select count(*) from uniora_policies where organization_id = new.organization_id) >= 1000
begin
  select raise(abort, 'policy_limit_reached: an organization can have at most 1000 policies');
end;

create trigger if not exists uniora_policies_retired_update
before update on uniora_policies
when old.status = 'retired'
begin
  select raise(abort, 'policy_retired: a retired policy cannot change');
end;

create trigger if not exists uniora_policies_immutable_update
before update on uniora_policies
when new.id <> old.id or new.organization_id <> old.organization_id or new.key <> old.key or new.created_at <> old.created_at
  or new.created_by_provider <> old.created_by_provider or new.created_by_subject <> old.created_by_subject
  or (old.activated_at is not null and new.activated_at is not old.activated_at)
begin
  select raise(abort, 'policy_immutable: id, organization, key, creation data and activated_at never change');
end;

create trigger if not exists uniora_policies_version_update
before update on uniora_policies
when new.version <> old.version + 1
begin
  select raise(abort, 'policy_immutable: version must go up by exactly one per change');
end;

create trigger if not exists uniora_policies_transition_update
before update on uniora_policies
when new.status <> old.status and not (
  (old.status = 'draft' and new.status = 'active') or
  (old.status = 'active' and new.status in ('disabled', 'retired')) or
  (old.status = 'disabled' and new.status in ('active', 'retired')))
begin
  select raise(abort, 'policy_transition_invalid: that is not a legal move');
end;

create trigger if not exists uniora_policies_active_limit_update
before update on uniora_policies
when new.status = 'active' and old.status <> 'active'
  and (select count(*) from uniora_policies where organization_id = new.organization_id and status = 'active') >= 200
begin
  select raise(abort, 'policy_limit_reached: an organization can have at most 200 active policies');
end;

create trigger if not exists uniora_policies_revision_step_update
before update on uniora_policies
when (new.revision <> old.revision and new.revision <> old.revision + 1)
  or ((new.revision = old.revision) <> (new.definition_hash = old.definition_hash))
  or (new.revision = old.revision and json(new.definition) <> json(old.definition))
begin
  select raise(abort, 'policy_immutable: the definition changes only together with a new revision');
end;

-- A policy can only move to a revision that exists, for the same organization, with this very definition.
create trigger if not exists uniora_policies_revision_matches_update
before update on uniora_policies
when (new.revision <> old.revision or new.definition_hash <> old.definition_hash)
  and not exists (
    select 1 from uniora_policy_revisions r
    where r.policy_id = new.id and r.revision = new.revision and r.definition_hash = new.definition_hash and json(r.definition) = json(new.definition))
begin
  select raise(abort, 'policy_immutable: the policy definition does not match its current revision');
end;

-- A policy that was ever active is history for the audit trail: retire it instead. Deleting the organization still cascades.
create trigger if not exists uniora_policies_guard_delete
before delete on uniora_policies
when (old.status <> 'draft' or old.activated_at is not null) and exists (select 1 from uniora_organizations where id = old.organization_id)
begin
  select raise(abort, 'policy_not_draft: only a policy that was never active can be deleted');
end;

create trigger if not exists uniora_policy_revisions_limit_insert
before insert on uniora_policy_revisions
when (select count(*) from uniora_policy_revisions where policy_id = new.policy_id) >= 1000
begin
  select raise(abort, 'policy_limit_reached: a policy can have at most 1000 revisions');
end;

-- A new revision is the current one (written right after its policy) or the next one (written right before the policy moves to it).
create trigger if not exists uniora_policy_revisions_consistent_insert
after insert on uniora_policy_revisions
when exists (
    select 1 from uniora_policies p
    where p.id = new.policy_id
      and ((p.revision = new.revision and (p.definition_hash <> new.definition_hash or json(p.definition) <> json(new.definition)))
        or new.revision > p.revision + 1))
begin
  select raise(abort, 'policy_immutable: the revision does not match the policy');
end;

create trigger if not exists uniora_policy_revisions_immutable_update
before update on uniora_policy_revisions
begin
  select raise(abort, 'policy_immutable: a revision never changes');
end;

create trigger if not exists uniora_policy_revisions_guard_delete
before delete on uniora_policy_revisions
when exists (select 1 from uniora_policies where id = old.policy_id)
begin
  select raise(abort, 'policy_immutable: a revision never changes');
end;

create trigger if not exists uniora_policies_bump_insert
after insert on uniora_policies
begin
  insert into uniora_policy_set_revisions (organization_id, revision) values (new.organization_id, 1)
  on conflict (organization_id) do update set revision = revision + 1;
end;

create trigger if not exists uniora_policies_bump_update
after update on uniora_policies
begin
  insert into uniora_policy_set_revisions (organization_id, revision) values (new.organization_id, 1)
  on conflict (organization_id) do update set revision = revision + 1;
end;

create trigger if not exists uniora_policies_bump_delete
after delete on uniora_policies
when exists (select 1 from uniora_organizations where id = old.organization_id)
begin
  insert into uniora_policy_set_revisions (organization_id, revision) values (old.organization_id, 1)
  on conflict (organization_id) do update set revision = revision + 1;
end;
`;
