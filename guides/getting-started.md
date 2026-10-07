# Getting started

By the end of this page you will have a SQLite database with UNIORA's tables, an organization with a protected Owner, a role
with one permission, a second member who can do exactly that one thing, and a feature switched on for the organization.

You need Node.js 20.6 or newer (CI runs 22 and 24). Nothing else: SQLite is a file. (PostgreSQL works the same way, see [Storage](storage.md).)

## 1. Install

```bash
npm install @uniora/core @uniora/sqlite better-sqlite3
npm install --save-dev @uniora/cli          # optional: migrations, doctor and Studio from the terminal
```

## 2. Open the database and create the tables

```ts
import { createAuthorizationEngine, createOrganizationWithOwner } from "@uniora/core";
import { applyMigrations, createSqliteStorage, openSqliteDatabase } from "@uniora/sqlite";

const db = openSqliteDatabase("app.db"); // creates the file with private permissions, foreign keys on
applyMigrations(db);                      // idempotent: safe to run on every start
const storage = createSqliteStorage(db);
```

`storage` is the only object UNIORA needs. Everything below goes through it or through the engine built on top of it.

## 3. Create an organization

Your auth provider tells you who the user is. UNIORA calls that an **identity**: a `provider` name and the provider's stable
`subject` (the user id). Use the [adapter](identity-adapters.md) for your provider to get one from a session; here we write it by hand.

```ts
const alice = { provider: "supabase", subject: "user_alice" };

const { organization, ownerRole, membership } = await createOrganizationWithOwner(storage, {
  organizationId: crypto.randomUUID(),
  organizationName: "Acme Motors", // slug "acme-motors" is derived unless you pass organizationSlug
  ownerRoleId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  ownerIdentity: alice,
});
```

The organization, its Owner role and Alice's membership are created in one transaction, so an organization without an Owner can
never exist. UNIORA does not generate ids for you here: pass UUIDs (or any unique strings) from your own code.

## 4. Register permissions and create a role

A permission is a key like `vehicles.delete` (lowercase, `resource.action`). Register the ones your app uses once, at startup.

```ts
await storage.permissions.register({ key: "vehicles.read", name: "View vehicles", group: "Vehicles" });
await storage.permissions.register({ key: "vehicles.delete", name: "Delete vehicles", group: "Vehicles" });

const viewer = await storage.roles.create({
  id: crypto.randomUUID(),
  organizationId: organization.id,
  name: "Viewer",                       // key "viewer" is derived
  permissionKeys: ["vehicles.read"],
});
```

## 5. Add a member and check access

```ts
const bob = { provider: "supabase", subject: "user_bob" };
await storage.memberships.create({
  id: crypto.randomUUID(),
  organizationId: organization.id,
  identity: bob,
  roleIds: [viewer.id],
});

const engine = createAuthorizationEngine(storage, { ownerRequiresRegisteredPermission: true });

await engine.can({ identity: bob, organizationId: organization.id, permission: "vehicles.read" });   // true
await engine.can({ identity: bob, organizationId: organization.id, permission: "vehicles.delete" }); // false
await engine.can({ identity: alice, organizationId: organization.id, permission: "vehicles.delete" }); // true: Owner
await engine.can({ identity: { provider: "supabase", subject: "stranger" }, organizationId: organization.id, permission: "vehicles.read" }); // false
```

Anything the engine cannot justify is `false`: unknown permission, no membership, a role from another organization, a blocked
member, a suspended organization.

## 6. Switch a feature on for the organization

Permissions answer "what may this person do". **Features** answer "what has this organization unlocked".

```ts
await storage.features.register({ key: "ai_assistant", name: "AI assistant" }); // off by default
await storage.features.enable(organization.id, "ai_assistant", { actor: alice, reason: "Pro plan" });

await engine.access.check({
  identity: alice,
  organizationId: organization.id,
  permission: "vehicles.read",
  feature: "ai_assistant",
}); // true only if the person has the permission AND the organization has the feature
```

## 7. Record who did what

Wrap the storage once per request with the acting identity and every change is written to the tamper-evident audit log, in the
same transaction as the change:

```ts
import { createAuditedStorage } from "@uniora/core";

const audited = createAuditedStorage(storage, { actor: alice });
await audited.roles.update(viewer.id, { description: "Read-only access" });
const entries = await storage.auditLogs.listByOrganization(organization.id, { limit: 10 });
```

See [Audit log](audit-log.md).

## Where to go next

- Put the engine in front of your routes: [Frameworks](frameworks.md) (Express, Next.js, React).
- Let people join: [Invitations](invitations.md).
- Look at your data without writing code: `npx uniora studio` ([CLI and Studio](cli-and-studio.md)).
- Going to production: [Hardening](hardening.md).
- Authorization belongs at the edges of **your** code: UNIORA's repositories do not check who is calling them. Call
  `engine.can(...)` before `storage.roles.update(...)` and friends, as the [concepts](concepts.md#who-authorizes-the-caller) page explains.
