# UNIORA documentation

Start with **Getting started**, read **Concepts** once, and keep the **Reference** open while you build.

| If you want to… | Read |
| --- | --- |
| Get a working organization with an Owner and a permission check in ten minutes | [Getting started](getting-started.md) |
| Understand organizations, memberships, roles, permissions, features and why the engine denies by default | [Concepts](concepts.md) |
| Look up a function, repository method or type of `@uniora/core` | [Core reference](core-reference.md) |
| Choose and set up storage (memory, PostgreSQL, SQLite), run migrations, use transactions | [Storage](storage.md) |
| Plug in Supabase, Clerk, Auth0 or Better Auth and turn a session into an `Identity` | [Identity adapters](identity-adapters.md) |
| Guard routes in Express or Next.js and hide UI in React | [Frameworks](frameworks.md) |
| Invite people by e-mail, accept invitations, write your own sender | [Invitations](invitations.md) |
| Read, verify and prune the audit log | [Audit log](audit-log.md) |
| Use `npx uniora …` and Studio, and set environment variables | [CLI, Studio and configuration](cli-and-studio.md) |
| Translate or branch on an error | [Errors](errors.md) |

Topic guides that go deeper:

- [Hardening for production](hardening.md): database roles, anchoring the audit head, release settings.
- [Performance at scale](performance.md): paging, indexes, capped counts, measured numbers on 5 million rows, and what to know before migrating a large database.
- [Row-level security](rls.md): SQL functions for your own policies.
- [Events after commit (outbox)](outbox.md), [quotas (entitlements)](entitlements.md), [support grants](support-grants.md), [teams](teams.md), [policies](policies.md), [platform administrators](platform.md).
- [Delegated administration](access-admin.md): let someone other than the Owner give roles and invite, without privilege escalation.
- [SQL migrations as plain files](sql-migrations.md) and [writing your own storage backend](custom-backend.md).
- [Roadmap](roadmap.md): what UNIORA does not do yet.

Per-package READMEs (install line and the shortest example) live next to each package:
[`core`](../packages/core), [`postgres`](../packages/database/postgres), [`sqlite`](../packages/database/sqlite),
[`mailer-smtp`](../packages/mailer-smtp), [`next`](../packages/next), [`express`](../packages/express),
[`react`](../packages/react), [`cli`](../packages/cli), [`studio`](../apps/studio) and the four
[adapters](../packages/adapters). A runnable app is in [`examples/express-sqlite`](../examples/express-sqlite), and
[`apps/playground`](../apps/playground) shows Next.js + React.

Code samples are TypeScript and ES modules.
