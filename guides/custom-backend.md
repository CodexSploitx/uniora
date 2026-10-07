# Writing a storage backend: the contract tests

`@uniora/core` only talks to `UnioraStorage` (repositories for organizations, memberships, roles, permissions, features,
entitlements, support grants, the audit log, invitations, identity links and the outbox, plus `transaction`). Memory, Postgres
and SQLite implement it; a third backend (MySQL, DynamoDB, a service of yours) must behave **identically**, not "about the same",
because the authorization decisions, the last-Owner guard and the audit chain depend on those details.

The behaviour is pinned by one shared suite, `packages/database/conformance` (`@uniora/storage-conformance`, private to this
repository: it is source, not a published package). Both real adapters run exactly the same ~200 tests; that is the battery.

```ts
// my-backend/src/storage.test.ts, inside this monorepo (or a copy of the suite)
import { defineStorageConformance } from "@uniora/storage-conformance";

defineStorageConformance({
  name: "my-backend",
  async setup() { /* connect, migrate */ },
  async teardown() { /* disconnect */ },
  async reset() { /* empty every table before each test */ },
  storage: () => createMyStorage(connection),
  probe: { /* a few raw-SQL helpers: forge a row, tamper with an audit row … see harness.ts */ },
});
```

What the suite checks that is easy to get wrong:

- **Atomicity**: the last active Owner can't be removed, blocked or demoted even by two requests at once; `consume` never passes a limit; `claim` never hands one outbox event to two workers; a rolled-back `transaction` leaves no rows (and no outbox events).
- **Tenant isolation**: a role, membership or invitation of another organization is never trusted.
- **The audit log is tamper-evident**: append-only, hash-chained, retention only through the privileged path.
- **Fail closed**: unknown, malformed or blocked means denied, never an exception that a caller could mistake for "allowed".
- **Identical errors**: each failure carries the same stable `code` in every backend.

If you write a backend, run the suite before anything else and treat every failure as a bug in the backend, not in the test. The
Postgres SQL functions for RLS (`guides/rls.md`) have their own cross-check against the engine in `rls-functions.test.ts`; a
backend that offers row-level policies must do the same.

Publishing the suite as an npm package (compiled, with `vitest` as a peer dependency) is a small step if outside backends become
a goal; it is deliberately not done yet.
