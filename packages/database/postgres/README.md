# @uniora/postgres

PostgreSQL storage adapter for [UNIORA](https://github.com/CodexSploitx/uniora). Everything lives in a dedicated `uniora` schema, so it never collides with your own tables. It passes the same behavioural conformance suite as `@uniora/sqlite`, including the concurrency and security regressions, against a real database.

```bash
npm install @uniora/core @uniora/postgres pg
```

```ts
import { Pool } from "pg";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await applyMigrations(pool);                  // additive and idempotent, tracked in a ledger
const storage = createPostgresStorage(pool);
```

- Migrations are never destructive. `npx uniora migrate --status` exits 1 in CI if some are pending or were edited after being applied.
- The audit log is append-only in the database itself (triggers) and hash-chained.
- For production, run the app with the least-privilege role from [`guides/sql/least-privilege-roles.sql`](https://github.com/CodexSploitx/uniora/blob/main/guides/sql/least-privilege-roles.sql) and migrations with another.

Documentation: [Storage guide](https://github.com/CodexSploitx/uniora/blob/main/guides/storage.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
