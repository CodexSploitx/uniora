/**
 * Cross-provider identity linking (docs/PROYECT.md §14-15, `@uniora/core`'s
 * `IdentityLinkRepository`). Global on purpose — not scoped to an
 * organization — because a person's provider migration applies everywhere
 * they're a member, and `findByIdentity`'s per-organization query still
 * enforces tenant isolation on the membership side.
 *
 * `primary key (from_provider, from_subject)` is the DB-level backstop
 * against a race: two concurrent `link()` calls for the same `from` cannot
 * both succeed — the second gets a unique-violation, which the repository
 * turns into a clear `IdentityLinkError` instead of leaking the raw
 * Postgres error (see `repositories/identity-link.ts`).
 */
export const MIGRATION_0003_IDENTITY_LINKS = `
create table if not exists uniora.identity_links (
  from_provider text not null,
  from_subject text not null,
  to_provider text not null,
  to_subject text not null,
  linked_at timestamptz not null default now(),
  primary key (from_provider, from_subject)
);
`;
