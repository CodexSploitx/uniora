-- @uniora/sqlite migration 0024_search_indexes
-- Generated from src/migrations/0024_search_indexes.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Substring search at any size. `search({ query })` means "contains, ignoring case" (ILIKE on Postgres); on SQLite that
-- was a function called on every row, which is seconds on a few million memberships. Trigram indexes answer the same
-- question from an index: a query of three characters or more finds its candidate rows in milliseconds, and the
-- repository still re-checks each candidate with the exact same predicate, so what matches does not change.
--
-- The indexes are FTS5 external-content tables over the existing rows (no second copy of the text beyond the trigrams),
-- kept current by triggers. A database that already has rows builds them here once: roughly a minute per five million
-- memberships. `insert into <table>(<table>) values('rebuild')` rebuilds one if it is ever needed.
--
-- Also: a person's memberships across organizations (`findByIdentity`, the member's "other organizations", every
-- authorization lookup that starts from an identity) filter on `(provider, subject)`, and nothing led with those columns
-- (the unique key starts with `organization_id`). And `(status, id)`: the cross-organization "blocked members" view had no index to start from.

create index if not exists uniora_memberships_identity_idx on uniora_memberships (provider, subject);
create index if not exists uniora_memberships_status_idx on uniora_memberships (status, id);

create virtual table if not exists uniora_memberships_search using fts5(
  provider, subject, content='uniora_memberships', content_rowid='rowid', tokenize='trigram'
);
create trigger if not exists uniora_memberships_search_ai after insert on uniora_memberships begin
  insert into uniora_memberships_search(rowid, provider, subject) values (new.rowid, new.provider, new.subject);
end;
create trigger if not exists uniora_memberships_search_ad after delete on uniora_memberships begin
  insert into uniora_memberships_search(uniora_memberships_search, rowid, provider, subject) values ('delete', old.rowid, old.provider, old.subject);
end;
create trigger if not exists uniora_memberships_search_au after update of provider, subject on uniora_memberships begin
  insert into uniora_memberships_search(uniora_memberships_search, rowid, provider, subject) values ('delete', old.rowid, old.provider, old.subject);
  insert into uniora_memberships_search(rowid, provider, subject) values (new.rowid, new.provider, new.subject);
end;
insert into uniora_memberships_search(uniora_memberships_search) values ('rebuild');

create virtual table if not exists uniora_organizations_search using fts5(
  name, slug, content='uniora_organizations', content_rowid='rowid', tokenize='trigram'
);
create trigger if not exists uniora_organizations_search_ai after insert on uniora_organizations begin
  insert into uniora_organizations_search(rowid, name, slug) values (new.rowid, new.name, new.slug);
end;
create trigger if not exists uniora_organizations_search_ad after delete on uniora_organizations begin
  insert into uniora_organizations_search(uniora_organizations_search, rowid, name, slug) values ('delete', old.rowid, old.name, old.slug);
end;
create trigger if not exists uniora_organizations_search_au after update of name, slug on uniora_organizations begin
  insert into uniora_organizations_search(uniora_organizations_search, rowid, name, slug) values ('delete', old.rowid, old.name, old.slug);
  insert into uniora_organizations_search(rowid, name, slug) values (new.rowid, new.name, new.slug);
end;
insert into uniora_organizations_search(uniora_organizations_search) values ('rebuild');

create virtual table if not exists uniora_invitations_search using fts5(
  email, content='uniora_invitations', content_rowid='rowid', tokenize='trigram'
);
create trigger if not exists uniora_invitations_search_ai after insert on uniora_invitations begin
  insert into uniora_invitations_search(rowid, email) values (new.rowid, new.email);
end;
create trigger if not exists uniora_invitations_search_ad after delete on uniora_invitations begin
  insert into uniora_invitations_search(uniora_invitations_search, rowid, email) values ('delete', old.rowid, old.email);
end;
create trigger if not exists uniora_invitations_search_au after update of email on uniora_invitations begin
  insert into uniora_invitations_search(uniora_invitations_search, rowid, email) values ('delete', old.rowid, old.email);
  insert into uniora_invitations_search(rowid, email) values (new.rowid, new.email);
end;
insert into uniora_invitations_search(uniora_invitations_search) values ('rebuild');
