/**
 * Supports `OrganizationRepository.search` — a paginated, keyset-cursor
 * listing of organizations (e.g. Studio's `/organizations` page,
 * docs/studio.md). The table's only existing index is the primary key on
 * `id`; ordering/paging by `created_at` without this index would need a
 * full table scan + sort on every page, which gets slower as
 * `organizations` grows. `id asc` matches the keyset tiebreaker `search`
 * uses for organizations created in the same millisecond.
 *
 * The `query` filter itself (case-insensitive substring match against
 * `name`/`slug`) is intentionally not indexed here — a plain btree can't
 * serve `ilike '%...%'`, and adding `pg_trgm` for that is a bigger step
 * than this task needs at Studio's expected scale (thousands of rows, not
 * millions). Documented as a known limitation in docs/postgres.md.
 */
export const MIGRATION_0010_ORGANIZATIONS_CREATED_AT_INDEX = `
create index if not exists organizations_created_at_id_idx
  on uniora.organizations (created_at asc, id asc);
`;
