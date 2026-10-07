-- @uniora/sqlite migration 0002_invitations
-- Generated from src/migrations/0002_invitations.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Organization invitations (offer an e-mail address a membership with
-- specific roles).
--
-- - Only the SHA-256 of the accept token is stored (`token_hash`, unique):
--   a leaked database does not leak usable links.
-- - "At most one pending invitation per organization + e-mail" is a partial
--   unique index, so two concurrent invites can't both succeed.
-- - Accepting is a conditional update on `status = 'pending'` — the database,
--   not application code, makes a link single-use.
-- - Roles hang off `uniora_invitation_roles` and cascade away with the role
--   or the organization; delivery bookkeeping lives on the invitation row.

create table if not exists uniora_invitations (
  id text primary key,
  organization_id text not null references uniora_organizations (id) on delete cascade,
  email text not null check (email = lower(email) and length(email) between 3 and 254),
  token_hash text not null,
  invited_by_provider text not null,
  invited_by_subject text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at text not null,
  accepted_at text,
  accepted_by_provider text,
  accepted_by_subject text,
  revoked_at text,
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sent', 'failed')),
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  delivery_sends integer not null default 0 check (delivery_sends >= 0),
  delivery_last_attempt_at text,
  delivery_sent_at text,
  delivery_last_error text
);
create unique index if not exists uniora_invitations_token_hash_key on uniora_invitations (token_hash);
create unique index if not exists uniora_invitations_one_pending_per_email
  on uniora_invitations (organization_id, email) where status = 'pending';
create index if not exists uniora_invitations_org_created_at_id_idx
  on uniora_invitations (organization_id, created_at desc, id desc);
create index if not exists uniora_invitations_email_created_at_idx on uniora_invitations (email, created_at);

create table if not exists uniora_invitation_roles (
  invitation_id text not null references uniora_invitations (id) on delete cascade,
  role_id text not null references uniora_roles (id) on delete cascade,
  primary key (invitation_id, role_id)
);
create index if not exists uniora_invitation_roles_role_idx on uniora_invitation_roles (role_id);
