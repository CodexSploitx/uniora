/**
 * Idempotent invitations: `invite({ idempotencyKey })` stores the caller's key and a hash of what was asked, so a
 * retry with the same key and request returns the invitation that already exists instead of failing with
 * `duplicate_pending` or creating a second one. The unique index is the guarantee: a key belongs to one invitation per
 * organization. Existing invitations have no key (null is never equal to null in a unique index).
 */
export const MIGRATION_0032_INVITATION_IDEMPOTENCY = `
alter table uniora.invitations add column if not exists idempotency_key text check (idempotency_key is null or length(idempotency_key) <= 128);
alter table uniora.invitations add column if not exists idempotency_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invitations_idempotency_consistent' and conrelid = 'uniora.invitations'::regclass) then
    alter table uniora.invitations
      add constraint invitations_idempotency_consistent check ((idempotency_key is null) = (idempotency_hash is null));
  end if;
end
$$;

create unique index if not exists invitations_idempotency_key_key on uniora.invitations (organization_id, idempotency_key);
`;
