# Performance at scale

UNIORA is meant to stay fast when a table has millions of rows. This page says what the library guarantees, how to read the numbers, and what to do when you upgrade a large database.

All figures below were measured on one small machine with **5,000,000 memberships** in 5,000 organizations (45,000 roles), once on SQLite and once on PostgreSQL 16.

## What you can rely on

- **Nothing loads "all of" anything.** Every listing is keyset-paged (`after` is the id or `createdAt, id` of the last row, never an `offset`) and takes a `limit`. The unpaginated `list()` methods exist only for small catalogs and internal aggregation.
- **Every filter is index-backed.** The SQL behind `search`, `count` and `searchListing` has an index for each filter it accepts: organization, status, identity (`provider`, `subject`), role holder, and text.
- **Text search is "contains, ignoring case" at any size.** SQLite uses FTS5 trigram indexes (maintained by triggers); PostgreSQL uses `pg_trgm` GIN indexes. A query shorter than three characters falls back to a scan (there are no trigrams to look up). The exact `ilike` test still runs on every candidate, so the answer never changes, only the speed.
- **Counts can be capped.** `count({ limit })` and `countByOrganization(ids, { limit })` stop at `limit`, so "how many match?" costs a page of work even when millions do. Ask for `limit + 1`: seeing the extra row is what tells you "more than `limit`". Without `limit` you get the exact number, which on millions of rows is a full pass (about 180 ms for 5 million memberships on SQLite).
- **Optional filters do not defeat the planner.** SQLite cannot use an index through `(?1 is null or col = ?1)`; the executor resolves the filters that are `null` before it prepares the statement, so each combination gets its own plan.

## Measured

Warm pages of Studio on 5,000,000 memberships (server time, one request each):

| Page | SQLite | PostgreSQL |
| --- | --- | --- |
| Overview, organizations, members, permissions, features, activity, platform | 20–60 ms | 15–80 ms |
| Members, search for a rare term (`user12345`) | 30–60 ms | 65–95 ms |
| Members, filter `status=blocked` (100,000 blocked rows) | 25–40 ms | 25–55 ms |
| Members, `status=blocked` plus a text search | 35–45 ms | about 210–260 ms |

Studio never counts the whole table on the request path: it shows "10,000+" (or "1,000+" when the list is filtered) when a count reaches its cap, and refreshes the exact whole-table totals in the background.

### Known limits

- **PostgreSQL, a term that matches a few percent of the table and is clustered in id order** (for example `user12` when ids and subjects are created together): the first page can take about half a second, because PostgreSQL has to read most of the matches to know which come first. Rare terms and very common terms are fast; the middle is the slow part.
- **SQLite**: the exact whole-table total of a very large table is a single synchronous query (about 180 ms at 5 million rows) that blocks the process while it runs; Studio runs it at most once every two minutes and answers with the capped count meanwhile.

## Upgrading a large database

`uniora migrate` applies these; read them first if your tables are big.

| Engine | Migration | What it does | Cost on 5M memberships |
| --- | --- | --- | --- |
| SQLite | `0024_search_indexes` | Trigram FTS5 tables for memberships, organizations and invitations (plus triggers), an index on `(provider, subject)`, and one on `(status, id)` | Roughly a minute to build; the database is locked meanwhile |
| PostgreSQL | `0039_search_indexes` | `pg_trgm` GIN indexes, an index on `(provider, subject)`, and one on `(status, id)` | A minute or two; `create index` blocks writes to the table meanwhile, so run it in a quiet moment |

PostgreSQL: `pg_trgm` is a trusted extension (PostgreSQL 13+), so the database owner can create it. If your role cannot, the migration still succeeds (search keeps working, just without the trigram indexes) and prints a notice; a superuser then runs `create extension pg_trgm` and the `create index` statements of the migration, which are idempotent.

## Writing queries on top of UNIORA

- Page with `after`, not `offset`, and ask for `limit + 1` rows to know whether another page exists.
- Use `count({ limit })` for anything shown next to a list.
- Look rows up in batches (`findByIds`, `countByOrganization`, `summarizeUsage`), never one query per row.
- If you add your own tables that join to UNIORA's, index the foreign key and the column you sort by together, as UNIORA does (`organization_id, id`).
