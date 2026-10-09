-- @uniora/sqlite migration 0026_policy_revision_sequence
-- Generated from src/migrations/0026_policy_revision_sequence.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Policy-set revisions that are never reused.
--
-- Every change to a policy now takes its revision number from ONE counter shared by all organizations, so a number is unique for
-- the lifetime of the database. Before, each organization counted from 1 and the counter went away with the organization: an
-- organization deleted and created again under the same id restarted at 1, and a process still holding the old policies in its
-- cache at that number would have kept using them. Numbers are no longer consecutive: compare them, never count them.
-- The counter starts above every number already handed out.

create table if not exists uniora_policy_revision_counter (
  id integer primary key check (id = 1),
  value integer not null check (value >= 0)
);
insert or ignore into uniora_policy_revision_counter (id, value)
  select 1, coalesce(max(revision), 1) from uniora_policy_set_revisions;

drop trigger if exists uniora_policies_bump_insert;
drop trigger if exists uniora_policies_bump_update;
drop trigger if exists uniora_policies_bump_delete;

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
