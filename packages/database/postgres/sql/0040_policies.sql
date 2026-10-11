-- @uniora/postgres migration 0040_policies
-- Generated from src/migrations/0040_policies.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Policies: declarative rules that only ever RESTRICT what the role-based engine allows (see guides/policies.md).
--
-- - A policy belongs to exactly one organization (`organization_id`, cascade on delete). `key` is unique WITHIN the
--   organization for all time (a retired policy keeps its key). `kind` and `effect` are derived from the definition and the
--   database checks they agree with it.
-- - `policy_revisions` holds every definition the policy ever had, immutable (a trigger refuses UPDATE, and DELETE unless
--   the policy itself is gone). The policy row points at its CURRENT revision through a deferred composite key
--   `(policy_id, organization_id, revision, definition_hash)`, and a deferred trigger checks the definition on the policy row is
--   exactly the one in that revision. So the active definition can never drift from its history, and a revision of
--   organization A can never be attached to a policy of organization B (composite keys include `organization_id`).
-- - Lifecycle rules live in a trigger as well as in the repository: retired is terminal, only the legal moves are accepted,
--   `activated_at` is set once, a policy that was ever active cannot be deleted, `version` goes up by one per change.
-- - Limits: 1000 policies per organization, 200 active (keep in sync with MAX_POLICIES_PER_ORGANIZATION and
--   MAX_ACTIVE_POLICIES in @uniora/core), 1000 revisions per policy. Writers of one organization are serialised by an
--   advisory lock so two concurrent activations cannot both slip under the limit.
-- - `policy_set_revisions`: one counter per organization that goes up on every change to any of its policies. The decision
--   engine caches the active set by this number.
--
-- Reads are always \`organization_id = $1\` first: a single organization has at most 1000 policies, so every listing is a short
-- index range scan, independent of how many organizations or members exist.

create table if not exists uniora.policies (
  id text primary key check (length(id) between 1 and 200),
  organization_id text not null references uniora.organizations (id) on delete cascade,
  key text not null check (length(key) between 1 and 100 and key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
  name text not null check (length(name) between 1 and 255),
  description text check (description is null or length(description) between 1 and 1000),
  kind text not null check (kind in ('access', 'resource', 'scope', 'feature')),
  effect text not null check (effect in ('deny', 'require')),
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled', 'retired')),
  revision integer not null default 1 check (revision >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 16384),
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  updated_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  activated_at timestamptz(3),
  status_changed_at timestamptz(3),
  status_changed_by_provider text,
  status_changed_by_subject text,
  status_reason text check (status_reason is null or length(status_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  unique (organization_id, key),
  unique (id, organization_id),
  check (kind = definition ->> 'kind' and effect = definition ->> 'effect'),
  check ((status = 'draft') = (activated_at is null)),
  check ((status_changed_at is null) = (status_changed_by_provider is null) and (status_changed_at is null) = (status_changed_by_subject is null))
);
create index if not exists policies_org_idx on uniora.policies (organization_id, id);
create index if not exists policies_active_idx on uniora.policies (organization_id, id) where status = 'active';

create table if not exists uniora.policy_revisions (
  policy_id text not null,
  organization_id text not null,
  revision integer not null check (revision >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 16384),
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  created_by_provider text not null check (length(created_by_provider) between 1 and 200),
  created_by_subject text not null check (length(created_by_subject) between 1 and 500),
  note text check (note is null or length(note) between 1 and 500),
  primary key (policy_id, revision),
  unique (policy_id, organization_id, revision, definition_hash),
  foreign key (policy_id, organization_id) references uniora.policies (id, organization_id) on delete cascade
);

-- The current revision must exist, for the same organization, with the same hash (checked at commit, so a policy and its
-- first revision can be written in one transaction).
alter table uniora.policies drop constraint if exists policies_current_revision_fk;
alter table uniora.policies add constraint policies_current_revision_fk
  foreign key (id, organization_id, revision, definition_hash)
  references uniora.policy_revisions (policy_id, organization_id, revision, definition_hash)
  deferrable initially deferred;

create table if not exists uniora.policy_set_revisions (
  organization_id text primary key references uniora.organizations (id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0)
);

create or replace function uniora.policies_org_lock(org text) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended('uniora:policies:' || org, 0))
$$;

create or replace function uniora.policies_guard_insert() returns trigger
language plpgsql as $$
begin
  perform uniora.policies_org_lock(new.organization_id);
  if new.status <> 'draft' or new.revision <> 1 or new.version <> 1 then
    raise exception 'policy_immutable: a policy is created as draft, revision 1, version 1' using errcode = 'P0001';
  end if;
  if (select count(*) from uniora.policies where organization_id = new.organization_id) >= 1000 then
    raise exception 'policy_limit_reached: an organization can have at most 1000 policies' using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists policies_guard_insert on uniora.policies;
create trigger policies_guard_insert before insert on uniora.policies
  for each row execute function uniora.policies_guard_insert();

create or replace function uniora.policies_guard_update() returns trigger
language plpgsql as $$
begin
  perform uniora.policies_org_lock(old.organization_id);
  if old.status = 'retired' then
    raise exception 'policy_retired: a retired policy cannot change' using errcode = 'P0001';
  end if;
  if new.id <> old.id or new.organization_id <> old.organization_id or new.key <> old.key or new.created_at <> old.created_at
     or new.created_by_provider <> old.created_by_provider or new.created_by_subject <> old.created_by_subject then
    raise exception 'policy_immutable: id, organization, key and creation data never change' using errcode = 'P0001';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'policy_immutable: version must go up by exactly one per change' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status = 'active') or
       (old.status = 'active' and new.status in ('disabled', 'retired')) or
       (old.status = 'disabled' and new.status in ('active', 'retired'))) then
    raise exception 'policy_transition_invalid: % -> % is not a legal move', old.status, new.status using errcode = 'P0001';
  end if;
  if new.revision <> old.revision and new.revision <> old.revision + 1 then
    raise exception 'policy_immutable: a revision goes up by one' using errcode = 'P0001';
  end if;
  if (new.revision = old.revision) <> (new.definition_hash = old.definition_hash) or (new.revision = old.revision and new.definition <> old.definition) then
    raise exception 'policy_immutable: the definition changes only together with a new revision' using errcode = 'P0001';
  end if;
  if old.activated_at is not null and new.activated_at is distinct from old.activated_at then
    raise exception 'policy_immutable: activated_at is set once' using errcode = 'P0001';
  end if;
  if new.status = 'active' and old.status <> 'active' then
    if (select count(*) from uniora.policies where organization_id = new.organization_id and status = 'active') >= 200 then
      raise exception 'policy_limit_reached: an organization can have at most 200 active policies' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists policies_guard_update on uniora.policies;
create trigger policies_guard_update before update on uniora.policies
  for each row execute function uniora.policies_guard_update();

-- A policy that was ever active is history for the audit trail: retire it instead. Deleting the organization still cascades.
create or replace function uniora.policies_guard_delete() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from uniora.organizations where id = old.organization_id) then
    perform uniora.policies_org_lock(old.organization_id);
    if old.status <> 'draft' or old.activated_at is not null then
      raise exception 'policy_not_draft: only a policy that was never active can be deleted' using errcode = 'P0001';
    end if;
  end if;
  return old;
end
$$;

drop trigger if exists policies_guard_delete on uniora.policies;
create trigger policies_guard_delete before delete on uniora.policies
  for each row execute function uniora.policies_guard_delete();

create or replace function uniora.policy_revisions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from uniora.policy_revisions where policy_id = new.policy_id) >= 1000 then
      raise exception 'policy_limit_reached: a policy can have at most 1000 revisions' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from uniora.policies where id = old.policy_id) then
    return old;
  end if;
  raise exception 'policy_immutable: a revision never changes' using errcode = 'P0001';
end
$$;

drop trigger if exists policy_revisions_guard on uniora.policy_revisions;
create trigger policy_revisions_guard before insert or update or delete on uniora.policy_revisions
  for each row execute function uniora.policy_revisions_guard();

-- The definition on the policy row is exactly the one in its current revision (the key checks existence, organization and hash).
create or replace function uniora.policies_check_revision() returns trigger
language plpgsql as $$
declare
  stored jsonb;
begin
  select definition into stored from uniora.policy_revisions where policy_id = new.id and revision = new.revision;
  if stored is distinct from new.definition then
    raise exception 'policy_immutable: the policy definition does not match its current revision' using errcode = 'P0001';
  end if;
  return null;
end
$$;

drop trigger if exists policies_check_revision on uniora.policies;
create constraint trigger policies_check_revision after insert or update on uniora.policies
  deferrable initially deferred
  for each row execute function uniora.policies_check_revision();

create or replace function uniora.policies_bump_set_revision() returns trigger
language plpgsql as $$
declare
  org text := coalesce(new.organization_id, old.organization_id);
begin
  -- Deleting an organization cascades here after the organization is gone: nothing to count then.
  if exists (select 1 from uniora.organizations where id = org) then
    insert into uniora.policy_set_revisions (organization_id, revision) values (org, 1)
    on conflict (organization_id) do update set revision = uniora.policy_set_revisions.revision + 1;
  end if;
  return null;
end
$$;

drop trigger if exists policies_bump_set_revision on uniora.policies;
create trigger policies_bump_set_revision after insert or update or delete on uniora.policies
  for each row execute function uniora.policies_bump_set_revision();
