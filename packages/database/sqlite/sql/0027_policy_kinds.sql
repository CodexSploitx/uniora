-- @uniora/sqlite migration 0027_policy_kinds
-- Generated from src/migrations/0027_policy_kinds.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- The policy kinds `contextual` (conditions on the time and on request signals) and `sensitive` (conditions on how strongly the
-- person authenticated) join `access`, `resource`, `scope` and `feature` (same change as `@uniora/postgres`'s `0042_policy_kinds`).
--
-- SQLite cannot change a CHECK constraint, so the two policy tables are rebuilt: their rows are copied aside, the tables are
-- dropped and created again with the wider `kind` list, the rows are put back (before any trigger exists, so the lifecycle
-- triggers do not see the copy as new policies), and the indexes and triggers are created again exactly as `0025_policies` and
-- `0026_policy_revision_sequence` left them. Revisions keep their numbers, hashes and creation data; the per-organization
-- set-revision counters and the shared counter are not touched, so a cached decision never sees a revision go backwards.
-- The schema accepts both new names together so that the release that adds the second one needs no new migration; the
-- definition language decides which kinds a release accepts.

create table uniora_policies_rebuild as select * from uniora_policies;
create table uniora_policy_revisions_rebuild as select * from uniora_policy_revisions;
drop table uniora_policy_revisions;
drop table uniora_policies;

create table uniora_policies (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora_organizations (id) on delete cascade,
  key text not null check (
    length(key) between 1 and 100 and key not glob '*[^a-z0-9._-]*' and key glob '[a-z0-9]*' and key glob '*[a-z0-9]' and key not glob '*[._-][._-]*'),
  name text not null check (length(name) between 1 and 255),
  description text check (description is null or length(description) between 1 and 1000),
  kind text not null check (kind in ('access', 'resource', 'scope', 'feature', 'contextual', 'sensitive')),
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

create table uniora_policy_revisions (
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

insert into uniora_policies (id, organization_id, key, name, description, kind, effect, status, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at, activated_at, status_changed_at, status_changed_by_provider, status_changed_by_subject, status_reason, version)
  select id, organization_id, key, name, description, kind, effect, status, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at, activated_at, status_changed_at, status_changed_by_provider, status_changed_by_subject, status_reason, version from uniora_policies_rebuild order by rowid;
insert into uniora_policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, note)
  select policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject, note from uniora_policy_revisions_rebuild order by rowid;
drop table uniora_policies_rebuild;
drop table uniora_policy_revisions_rebuild;

create index if not exists uniora_policies_org_idx on uniora_policies (organization_id, id);
create index if not exists uniora_policies_active_idx on uniora_policies (organization_id, id) where status = 'active';

create trigger uniora_policies_guard_insert
before insert on uniora_policies
when new.status <> 'draft' or new.revision <> 1 or new.version <> 1
begin
  select raise(abort, 'policy_immutable: a policy is created as draft, revision 1, version 1');
end;

create trigger uniora_policies_limit_insert
before insert on uniora_policies
when (select count(*) from uniora_policies where organization_id = new.organization_id) >= 1000
begin
  select raise(abort, 'policy_limit_reached: an organization can have at most 1000 policies');
end;

create trigger uniora_policies_retired_update
before update on uniora_policies
when old.status = 'retired'
begin
  select raise(abort, 'policy_retired: a retired policy cannot change');
end;

create trigger uniora_policies_immutable_update
before update on uniora_policies
when new.id <> old.id or new.organization_id <> old.organization_id or new.key <> old.key or new.created_at <> old.created_at
  or new.created_by_provider <> old.created_by_provider or new.created_by_subject <> old.created_by_subject
  or (old.activated_at is not null and new.activated_at is not old.activated_at)
begin
  select raise(abort, 'policy_immutable: id, organization, key, creation data and activated_at never change');
end;

create trigger uniora_policies_version_update
before update on uniora_policies
when new.version <> old.version + 1
begin
  select raise(abort, 'policy_immutable: version must go up by exactly one per change');
end;

create trigger uniora_policies_transition_update
before update on uniora_policies
when new.status <> old.status and not (
  (old.status = 'draft' and new.status = 'active') or
  (old.status = 'active' and new.status in ('disabled', 'retired')) or
  (old.status = 'disabled' and new.status in ('active', 'retired')))
begin
  select raise(abort, 'policy_transition_invalid: that is not a legal move');
end;

create trigger uniora_policies_active_limit_update
before update on uniora_policies
when new.status = 'active' and old.status <> 'active'
  and (select count(*) from uniora_policies where organization_id = new.organization_id and status = 'active') >= 200
begin
  select raise(abort, 'policy_limit_reached: an organization can have at most 200 active policies');
end;

create trigger uniora_policies_revision_step_update
before update on uniora_policies
when (new.revision <> old.revision and new.revision <> old.revision + 1)
  or ((new.revision = old.revision) <> (new.definition_hash = old.definition_hash))
  or (new.revision = old.revision and json(new.definition) <> json(old.definition))
begin
  select raise(abort, 'policy_immutable: the definition changes only together with a new revision');
end;

-- A policy can only move to a revision that exists, for the same organization, with this very definition.
create trigger uniora_policies_revision_matches_update
before update on uniora_policies
when (new.revision <> old.revision or new.definition_hash <> old.definition_hash)
  and not exists (
    select 1 from uniora_policy_revisions r
    where r.policy_id = new.id and r.revision = new.revision and r.definition_hash = new.definition_hash and json(r.definition) = json(new.definition))
begin
  select raise(abort, 'policy_immutable: the policy definition does not match its current revision');
end;

-- A policy that was ever active is history for the audit trail: retire it instead. Deleting the organization still cascades.
create trigger uniora_policies_guard_delete
before delete on uniora_policies
when (old.status <> 'draft' or old.activated_at is not null) and exists (select 1 from uniora_organizations where id = old.organization_id)
begin
  select raise(abort, 'policy_not_draft: only a policy that was never active can be deleted');
end;

create trigger uniora_policy_revisions_limit_insert
before insert on uniora_policy_revisions
when (select count(*) from uniora_policy_revisions where policy_id = new.policy_id) >= 1000
begin
  select raise(abort, 'policy_limit_reached: a policy can have at most 1000 revisions');
end;

-- A new revision is the current one (written right after its policy) or the next one (written right before the policy moves to it).
create trigger uniora_policy_revisions_consistent_insert
after insert on uniora_policy_revisions
when exists (
    select 1 from uniora_policies p
    where p.id = new.policy_id
      and ((p.revision = new.revision and (p.definition_hash <> new.definition_hash or json(p.definition) <> json(new.definition)))
        or new.revision > p.revision + 1))
begin
  select raise(abort, 'policy_immutable: the revision does not match the policy');
end;

create trigger uniora_policy_revisions_immutable_update
before update on uniora_policy_revisions
begin
  select raise(abort, 'policy_immutable: a revision never changes');
end;

create trigger uniora_policy_revisions_guard_delete
before delete on uniora_policy_revisions
when exists (select 1 from uniora_policies where id = old.policy_id)
begin
  select raise(abort, 'policy_immutable: a revision never changes');
end;

create trigger uniora_policies_bump_insert
after insert on uniora_policies
begin
  update uniora_policy_revision_counter set value = value + 1 where id = 1;
  insert into uniora_policy_set_revisions (organization_id, revision) values (new.organization_id, (select value from uniora_policy_revision_counter where id = 1))
  on conflict (organization_id) do update set revision = excluded.revision;
end;

create trigger uniora_policies_bump_update
after update on uniora_policies
begin
  update uniora_policy_revision_counter set value = value + 1 where id = 1;
  insert into uniora_policy_set_revisions (organization_id, revision) values (new.organization_id, (select value from uniora_policy_revision_counter where id = 1))
  on conflict (organization_id) do update set revision = excluded.revision;
end;

create trigger uniora_policies_bump_delete
after delete on uniora_policies
when exists (select 1 from uniora_organizations where id = old.organization_id)
begin
  update uniora_policy_revision_counter set value = value + 1 where id = 1;
  insert into uniora_policy_set_revisions (organization_id, revision) values (old.organization_id, (select value from uniora_policy_revision_counter where id = 1))
  on conflict (organization_id) do update set revision = excluded.revision;
end;
