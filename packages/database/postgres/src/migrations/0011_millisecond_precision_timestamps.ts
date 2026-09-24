/**
 * Fixes a real keyset-pagination bug found while verifying
 * `OrganizationRepository.search` against 1020 seeded rows: Postgres
 * `timestamptz` stores microsecond precision, but a JS `Date` (and its
 * `toISOString()` round-trip, which every keyset cursor in this codebase —
 * `search`'s `after` and `listRecent`'s `before` — is built from) only
 * carries millisecond precision. Reconstructing a cursor from a JS `Date`
 * therefore truncates the true value downward (e.g. an actual
 * `20:04:50.437070` round-trips as `20:04:50.437000`), which is *less*
 * than the boundary row's real stored timestamp.
 *
 * For ascending pagination (`organizations.search`'s `after`, using
 * `(created_at, id) > (cursor)`) this let the boundary row match its own
 * cursor again — confirmed in practice: the exact-duplicate row reappeared
 * as the first item of the next page. For descending pagination
 * (`audit_logs.listRecent`'s `before`, using `(created_at, id) <
 * (cursor)`) the same truncation instead risks silently *skipping* any
 * row whose real timestamp falls strictly between the truncated cursor
 * and the boundary row's true value — harder to notice, but the same
 * root cause.
 *
 * Fixed at the source instead of in every query: both columns' `now()`
 * default is truncated to millisecond precision, so a value read back as
 * a JS `Date` and round-tripped through `toISOString()` is always exactly
 * equal to what's stored — no query-side truncation, no functional index
 * needed, the existing `(created_at, id)` indexes keep working unchanged.
 * Existing rows are backfilled the same way so already-seeded data (like
 * the 1020-organization scale test) stops exhibiting this too.
 */
export const MIGRATION_0011_MILLISECOND_PRECISION_TIMESTAMPS = `
alter table uniora.organizations alter column created_at set default date_trunc('milliseconds', now());
update uniora.organizations set created_at = date_trunc('milliseconds', created_at)
  where created_at <> date_trunc('milliseconds', created_at);

alter table uniora.audit_logs alter column created_at set default date_trunc('milliseconds', now());
update uniora.audit_logs set created_at = date_trunc('milliseconds', created_at)
  where created_at <> date_trunc('milliseconds', created_at);
`;
