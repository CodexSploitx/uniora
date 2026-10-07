# @uniora/core

The framework-independent heart of [UNIORA](https://github.com/CodexSploitx/uniora): organizations with a protected Owner, custom roles, permissions, features, audit logs, identity linking, invitations and the deny-by-default `AuthorizationEngine`. It has no dependency on any framework or database driver; storage comes from `@uniora/postgres` or `@uniora/sqlite` (or `createMemoryStorage()` for tests).

```bash
npm install @uniora/core @uniora/sqlite better-sqlite3   # or @uniora/postgres pg
```

```ts
import { createAuthorizationEngine, createOrganizationWithOwner } from "@uniora/core";
import { applyMigrations, createSqliteStorage, openSqliteDatabase } from "@uniora/sqlite";

const db = openSqliteDatabase("app.db");
applyMigrations(db);
const storage = createSqliteStorage(db);

// Every organization is born with exactly one protected Owner.
await createOrganizationWithOwner(storage, {
  organizationId: crypto.randomUUID(),
  organizationName: "Acme Motors",
  ownerRoleId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  ownerIdentity: { provider: "supabase", subject: userId },
});

const engine = createAuthorizationEngine(storage, { ownerRequiresRegisteredPermission: true });
const allowed = await engine.can({ identity, organizationId, permission: "vehicles.delete" }); // deny by default
const unlocked = await engine.access.check({ identity, organizationId, permission: "assistant.use", feature: "ai_assistant" });
```

## What is in the box

| Area | Entry points |
| --- | --- |
| Authorization | `createAuthorizationEngine` (`can`, `access.check`, `onDecision`), `computeAuthorizationSnapshot` |
| Organizations | `createOrganizationWithOwner`, `storage.organizations` |
| Members and ownership | `storage.memberships`, `transferOwnership`, `leaveOrganization` (the last Owner can never leave) |
| Roles, permissions, features | `storage.roles`, `storage.permissions`, `storage.features` |
| Invitations | `createInvitationService` (`invite`, `resend`, `revoke`, `preview`, `accept`), `invitationErrorToHttp` |
| Audit | `storage.auditLogs`, `createAuditedStorage`, `auditLogs.verifyIntegrity()` (append-only, hash-chained) |
| Identity | `Identity`, `storage.identityLinks` (migrate providers without losing anything) |

## Things to know

- **Authorization is yours at the edges.** The invitation service, `assignRole`, `transferOwnership` and friends do not authorize their caller: guard them with `engine.can` (we suggest `members.invite`, `roles.assign`, `organization.transfer_ownership`).
- Owner can't be granted by `assignRole` or by an invitation; use `assignOwnerRole` or `transferOwnership`.
- See the [hardening guide](https://github.com/CodexSploitx/uniora/blob/main/guides/hardening.md) before going to production.

Documentation: [Core reference](https://github.com/CodexSploitx/uniora/blob/main/guides/core-reference.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
