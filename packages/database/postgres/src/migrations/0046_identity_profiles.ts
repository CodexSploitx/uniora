/**
 * Who a person is, for screens: the display name, e-mail and avatar URL of an identity, as the host's auth provider knows them
 * (`@uniora/core`'s `IdentityProfileRepository`). Global on purpose, like `identity_links`: it is the same person in every
 * organization, and keyed by `(provider, subject)` so it survives the person leaving an organization.
 *
 * Display data only, never read by an authorization decision. `avatar_url` is a plain http(s) URL, never an object or a data URL.
 * Rows are written by the host's sync (the adapters' `toProfile`), not by a person typing in Studio.
 */
export const MIGRATION_0046_IDENTITY_PROFILES = `
create table if not exists uniora.identity_profiles (
  provider text not null,
  subject text not null,
  display_name text check (display_name is null or length(display_name) <= 320),
  email text check (email is null or length(email) <= 320),
  avatar_url text check (avatar_url is null or (length(avatar_url) <= 2048 and avatar_url ~* '^https?://')),
  updated_at timestamptz(3) not null default now(),
  primary key (provider, subject)
);
`;
