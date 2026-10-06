# @uniora/sqlite

SQLite storage adapter for [UNIORA](https://github.com/CodexSploitx/uniora), over [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3). Same `UnioraStorage` as `@uniora/postgres`, held to the same behavioural test suite. Good for local development, tests and small single-node apps.

```bash
npm install @uniora/core @uniora/sqlite better-sqlite3
```

```ts
import { applyMigrations, createSqliteStorage, openSqliteDatabase } from "@uniora/sqlite";

const db = openSqliteDatabase("app.db"); // private file permissions, foreign keys on and verified
applyMigrations(db);                     // synchronous and idempotent: safe on every start
const storage = createSqliteStorage(db);
```

- Bring **one connection per process**: the adapter serializes operations and runs each multi-statement operation in a `begin immediate` transaction, so another process on the same file waits its turn.
- The database file holds your authorization data: keep it out of git, the web root and shared backups.

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
