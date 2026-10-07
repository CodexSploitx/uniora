/**
 * Idempotent invitations — same model as `@uniora/postgres`'s `0032_invitation_idempotency`: `invite({ idempotencyKey })`
 * stores the caller's key and a hash of what was asked, so a retry with the same key and request returns the invitation
 * that already exists. The unique index makes a key belong to one invitation per organization; existing invitations have
 * no key (nulls never collide).
 */
export const MIGRATION_0017_INVITATION_IDEMPOTENCY = `
alter table uniora_invitations add column idempotency_key text check (idempotency_key is null or length(idempotency_key) <= 128);
alter table uniora_invitations add column idempotency_hash text check ((idempotency_key is null) = (idempotency_hash is null));
create unique index if not exists uniora_invitations_idempotency_key_key on uniora_invitations (organization_id, idempotency_key);
`;
