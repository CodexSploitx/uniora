# Storage

`@uniora/core` never speaks SQL. It talks to a `UnioraStorage`, and three implementations ship:

| Implementation | Package | Use it for |
| --- | --- | --- |
| In memory | `createMemoryStorage()` from `@uniora/core` | Unit tests, demos. Data disappears with the process. |
| PostgreSQL | `@uniora/postgres` | Production. Dedicated `uniora` schema. |
| SQLite | `@uniora/sqlite` | Local development, tests, small single-node apps. Tables are `uniora_*`. |

All three pass the same behavioural suite (about 200 tests, including concurrency and security regressions), so code written against one
works on the others. A backend of your own must pass it too: [Writing a storage backend](custom-backend.md).

## PostgreSQL

```bash
npm install @uniora/core @uniora/postgres pg
```

```ts
import { Pool } from "pg";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await applyMigrations(pool);              // additive, idempotent, recorded in uniora.schema_migrations
const storage = createPostgresStorage(pool);
```

- Everything lives in the `uniora` schema, so it never collides with your tables.
- Migrations are never destructive. A migration whose SQL changed after it was applied is reported as `modified` and blocks `applyMigrations`; a database newer than your code reports `unknown`.
- The audit log is append-only in the database itself (triggers) and hash-chained.
- Production: connect the app with the least-privilege role and run migrations with another ([Hardening §5](hardening.md), [`least-privilege-roles.sql`](sql/least-privilege-roles.sql)).
- If your team applies SQL with its own tooling (Flyway, Atlas, …), use the commented `.sql` files instead of `applyMigrations`: [SQL migrations](sql-migrations.md).
- Row-level security in your own tables can use UNIORA's SQL functions: [RLS](rls.md).

Inspect migrations from code:

```ts
import { getMigrationStatus, listMigrationIds } from "@uniora/postgres";
const status = await getMigrationStatus(pool); // { ledgerPresent, applied, pending, modified, unknown }
```

## SQLite

```bash
npm install @uniora/core @uniora/sqlite better-sqlite3
```

```ts
import { applyMigrations, createSqliteStorage, openSqliteDatabase } from "@uniora/sqlite";

const db = openSqliteDatabase("app.db", { wal: true }); // file created with 0600; foreign keys on and verified
applyMigrations(db);                                     // synchronous, idempotent
const storage = createSqliteStorage(db);
```

`openSqliteDatabase(path, { fileMustExist?, readonly?, wal? })`: `readonly` never creates or alters the file; `wal` needs a writable connection.
`sqlitePathFromUrl("sqlite:./app.db")` resolves the URL form the CLI uses; `hasUnioraSchema(db)` tells whether the tables exist.

- **One connection per process.** The adapter serializes operations and runs each multi-statement operation in a `begin immediate` transaction, so another process on the same file waits instead of racing.
- Timestamps are ISO-8601 text with milliseconds; case-insensitive searches fold Unicode case like the Postgres adapter.
- The file holds your authorization data: keep it out of git, the web root and shared backups.
- In-memory SQLite (`:memory:`) is rejected by the CLI because it vanishes when the command ends; use `createMemoryStorage()` in tests.

## In memory

```ts
import { createMemoryStorage } from "@uniora/core";
const storage = createMemoryStorage();
```

Same rules as the real adapters (Owner protection, deny by default, audit chain), no persistence. Create a fresh one per test.

## Transactions

```ts
await storage.transaction(async (tx) => {
  // use tx.*, not storage.*
});
```

Everything inside commits together or not at all, including outbox events and audit entries. Some operations take a lock internally
(`tx.lock(key)`) so check-then-insert sequences such as invitation rate limits can't interleave across processes.

## Choosing between Postgres and SQLite

| | PostgreSQL | SQLite |
| --- | --- | --- |
| Several app servers | Yes | No: one process owns the file |
| Row-level security functions | Yes | No |
| Least-privilege roles | Yes | File permissions only |
| Zero setup | No | Yes |

Moving from SQLite to Postgres later is a data migration you script yourself: the tables have the same shape, ids and timestamps carry over.
