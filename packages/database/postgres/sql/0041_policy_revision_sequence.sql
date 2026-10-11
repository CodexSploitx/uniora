-- @uniora/postgres migration 0041_policy_revision_sequence
-- Generated from src/migrations/0041_policy_revision_sequence.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Policy-set revisions that are never reused.
--
-- Until now each organization counted its own policy-set revision from 1 and the counter row went away with the organization.
-- An organization deleted and created again under the SAME id (a tenant removed and restored, or restored from a backup)
-- started counting from 1 again, so a process that still held the old organization's compiled policies in its cache at the same
-- number would have kept using them.
--
-- Now every change takes its number from ONE sequence shared by all organizations: a revision is unique for the lifetime of the
-- database, so equality is enough to know the cache is current. Numbers are no longer consecutive; compare them, never count them.
-- The sequence starts above every number already handed out. Roles that serve requests need `usage` on the sequence
-- (`grant usage, select on all sequences in schema uniora`, as in guides/sql/least-privilege-roles.sql).

create sequence if not exists uniora.policy_set_revision_seq as bigint;
select setval('uniora.policy_set_revision_seq', greatest((select coalesce(max(revision), 0) from uniora.policy_set_revisions), 1));

create or replace function uniora.policies_bump_set_revision() returns trigger
language plpgsql as $$
declare
  org text := coalesce(new.organization_id, old.organization_id);
begin
  -- Deleting an organization cascades here after the organization is gone: nothing to count then.
  if exists (select 1 from uniora.organizations where id = org) then
    insert into uniora.policy_set_revisions (organization_id, revision) values (org, nextval('uniora.policy_set_revision_seq'))
    on conflict (organization_id) do update set revision = excluded.revision;
  end if;
  return null;
end
$$;
