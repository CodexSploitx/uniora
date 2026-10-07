# Plain `.sql` migrations

`uniora migrate` (the CLI, or `applyMigrations(pool)` from code) is the normal way to create and upgrade UNIORA's tables. If your
team applies SQL with its own tooling (the Supabase CLI, Flyway, Atlas, a DBA review), the same migrations ship as plain,
commented files in each adapter's package:

| Adapter | Folder | Files |
| --- | --- | --- |
| `@uniora/postgres` | `node_modules/@uniora/postgres/sql/` | `0001_init.sql` … (one per migration, in order) |
| `@uniora/sqlite` | `node_modules/@uniora/sqlite/sql/` | `0001_init.sql` … |

Each file starts with a comment that says what the migration does and why (its security properties included), followed by the
exact SQL the migrator runs. They are generated from the TypeScript migrations and a test fails if they drift, so they can't
describe something different from what `applyMigrations` does.

```sh
# Supabase CLI: copy them in order into your migrations folder
for f in node_modules/@uniora/postgres/sql/*.sql; do
  cp "$f" "supabase/migrations/$(date -u +%Y%m%d%H%M%S)_uniora_$(basename "$f")"; sleep 1
done
```

## Rules

- **Order matters, and files never change.** A new UNIORA release adds files; apply only the ones you don't have yet. A published migration is never edited (the migrator refuses a changed checksum for the same reason).
- **Don't mix the two ways on SQLite.** The `.sql` files create no ledger table. In Postgres, running `uniora migrate` afterwards is safe (a database without a ledger is migrated once more, idempotently, and registered). In SQLite some migrations add columns and are not repeatable: pick one way and keep it.
- **Postgres roles**: the files expect to run as a role that can create the `uniora` schema. For the application's own role use `guides/sql/least-privilege-roles.sql`; the SQL functions for RLS are described in `guides/rls.md`.
- **Review before you apply**: they are ordinary SQL, no hidden steps. The ones that matter most for a review are `0021` (RLS functions: `security definer`, pinned `search_path`), `0022` (the only function allowed to delete audit rows) and `0025` (implied permissions in `has_permission`).

For contributors: after changing or adding a migration run `pnpm sql:export` and commit the result.
