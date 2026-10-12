/**
 * Who a person is, for screens (same model as `@uniora/postgres`'s `0046_identity_profiles`): the display name, e-mail and avatar
 * URL of an identity, as the host's auth provider knows them. Global, keyed by `(provider, subject)`, display data only, and
 * `avatar_url` is a plain http(s) URL, never an object or a data URL.
 */
export const MIGRATION_0031_IDENTITY_PROFILES = `
create table if not exists uniora_identity_profiles (
  provider text not null,
  subject text not null,
  display_name text check (display_name is null or length(display_name) <= 320),
  email text check (email is null or length(email) <= 320),
  avatar_url text check (avatar_url is null or (length(avatar_url) <= 2048 and (avatar_url like 'http://%' or avatar_url like 'https://%'))),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (provider, subject)
);
`;
