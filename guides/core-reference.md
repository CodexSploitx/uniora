# `@uniora/core` reference

Everything is exported from the package root: `import { … } from "@uniora/core"`. For the **browser**, the pure helpers are also
exported from [`@uniora/core/validation`](#browser-code-uniorecorevalidation). Every repository below is a property of
`UnioraStorage` (`storage.roles`, …) and of the `tx` object inside `storage.transaction(async (tx) => …)`.

**Conventions**

- Methods that look up one thing return `null` when it is missing. Methods that change something reject with a typed error that carries a stable `code` ([Errors](errors.md)).
- Lists are **keyset-paged** (`limit` + `after`/`before` cursor), never offset-paged. `list()` / `listCatalog()` exist for internal aggregation only: render people-facing lists with `search`.
- Batch methods (`findByIds`, `countByRole`, `listEffectiveMany`, …) answer a whole page in one call. Every requested id is present in a map result (`0` when none).
- **No repository checks who is calling.** Authorize first with `engine.can` (see [Concepts](concepts.md#who-authorizes-the-caller)).
- Wrap storage in [`createAuditedStorage`](audit-log.md) to have every change audited (and optionally enqueued in the outbox).

---

## Browser code: `@uniora/core/validation`

**What it is for.** The root entry point gathers the whole package, including parts that only make sense on a server (they use `node:crypto` and `node:net`: API keys, webhooks, policy hashing). A client component that imported one text helper from `@uniora/core` therefore made the bundler read those Node modules, and `next dev` with webpack failed with `UnhandledSchemeError: Reading from "node:crypto"`. The subpath `@uniora/core/validation` exports **only the pure helpers**, so a form can validate a name, a slug or a key with exactly the rules the server enforces.

**Requirements.** `@uniora/core` 1.2.0 or later. No configuration; the package also declares `"sideEffects": false`, so a bundler that tree-shakes drops what you do not use even from the root entry point.

**Minimal example (a client component):**

```tsx
"use client";
import { OrganizationError, resolveOrganizationSlug, sanitizeOrganizationName } from "@uniora/core/validation";

export function SlugPreview({ name }: { name: string }) {
  try {
    return <code>{resolveOrganizationSlug(sanitizeOrganizationName(name))}</code>; // "Acme Corp" → "acme-corp"
  } catch (error) {
    return error instanceof OrganizationError ? <em>{error.message}</em> : null;
  }
}
```

**What it exports** (the same functions as the root, not copies — a test compares them): `sanitizeOrganizationName`, `slugify`, `assertValidSlug`, `resolveOrganizationSlug`, `assertOrganizationStatus`, `sanitizeStatusReason`; `sanitizeRoleName`, `normalizeRoleName`, `assertValidRoleKey`, `resolveRoleKey`, `sanitizeRoleDescription`; `assertValidPermissionKey`, `sanitizePermissionName`; `assertValidFeatureKey`, `resolveFeatureKey`, `sanitizeFeatureName`; the team helpers (`resolveTeamSlug`, `sanitizeTeamName`, `sanitizeTeamData`, `sanitizeTeamExternalId`, `sanitizeTeamReason`) and their limits; `cleanProfileText`, `cleanAvatarUrl`; `sameIdentity`; and the error classes they throw (`UnioraError`, `OrganizationError`, `RoleError`, `PermissionError`, `FeatureError`, `TeamError`) with their `…ErrorCode` types.

**Rules that surprise.**

- Checking in the browser is a convenience for the person typing, **never the authority**: the server (or your own back end) runs the same function again, because a client can skip your page.
- Everything here is pure: no storage, no clock, no network, so nothing in it can answer "is this slug already taken?". Ask the server for that.
- Nothing from the root entry point that needs Node (`createApiKey`, webhook signing, `computePolicyHash`, storage) is available here, on purpose. A test walks the import graph of `validation.ts` and fails if a Node built-in or a package ever enters it.

**Errors.** The same typed errors and `code`s as on the server ([Errors](errors.md)); a failed helper throws, so wrap it in `try/catch` as above.

**HTTP API.** None: this is an embedded-library entry point, so `openapi.json`, `server-api.md` and `@uniora/client` do not change. A project that uses UNIORA as an external service does not need it.

**Adopting it.** Upgrade `@uniora/core` and replace `from "@uniora/core"` by `from "@uniora/core/validation"` in the files that run in the browser. Nothing else changes for code that keeps importing from the root.

---

## Authorization

### `createAuthorizationEngine(storage, options?)`

```ts
const engine = createAuthorizationEngine(storage, {
  ownerRequiresRegisteredPermission: true, // Owner passes only registered keys. Recommended for new projects.
  onDecision: (d) => log.info(d),          // every decision, allow and deny. Errors in the hook are swallowed.
});
```

| Method | Returns | Notes |
| --- | --- | --- |
| `engine.can({ identity, organizationId, permission })` | `Promise<boolean>` | Deny by default. See the conditions in [Concepts](concepts.md#the-engine-deny-by-default). |
| `engine.access.check({ identity, organizationId, permission?, feature? })` | `Promise<boolean>` | Feature must be effectively on **and** the permission held. Feature-only still requires membership. |

`AuthorizationDecision` (what `onDecision` receives): `{ kind: "can" | "access.check", identity, organizationId, permission?, feature?, allowed, via?: "membership" | "support_grant", reason: "evaluated" | "malformed_input", at }`.

### `computeAuthorizationSnapshot(engine, storage.features, input)`

```ts
const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
  identity, organizationId,
  permissions: ["vehicles.create"], // only the keys the view needs
  features: ["advanced_reports"],
});
// { organizationId, permissions: { "vehicles.create": true }, features: { advanced_reports: false } }
```

JSON-safe, for `@uniora/react`. A key you did not list is absent (treat as denied).

---

## Organizations: `storage.organizations`

`createOrganizationWithOwner(storage, { organizationId, organizationName, organizationSlug?, ownerRoleId, membershipId, ownerIdentity })`
creates the organization, its Owner role and the owner's membership in one transaction and returns `{ organization, ownerRole, membership }`.

| Method | Purpose |
| --- | --- |
| `create({ id, name, slug? })` | Slug derived from the name when omitted; unique. Prefer `createOrganizationWithOwner`. |
| `findById(id)` / `findByIds(ids)` | Unknown ids are absent. |
| `rename(id, name)` | Changes the name only; the slug (a URL handle) stays. |
| `update(id, { name?, slug? })` | Both at once; at least one required. |
| `setStatus(id, { status, actor, reason? })` | `active` / `suspended` / `archived`. Recorded in `statusChange`. |
| `search({ query?, status?, feature?, limit?, after? })` | Oldest first. `feature: { key, enabled? }` finds organizations where a feature is (or is not) effectively on. |
| `count({ query?, status?, feature? })` | Same filters, no rows loaded. |
| `list()` | Every organization. Internal use. |

Helpers: `slugify`, `assertValidSlug`, `resolveOrganizationSlug`, `sanitizeOrganizationName`, `ORGANIZATION_STATUSES`.
Name: up to 255 characters. Slug: lowercase alphanumerics separated by single hyphens.

---

## Memberships: `storage.memberships`

```ts
await storage.memberships.create({ id, organizationId, identity, roleIds: [roleId], invitedBy? });
await storage.memberships.block(membershipId, { actor, reason: "unpaid" }); // denied everything, roles kept
await storage.memberships.suspend(membershipId, { actor, reason: "vacation", until: new Date("2026-11-01") }); // status "suspended" until then
```

| Method | Purpose |
| --- | --- |
| `create({ id, organizationId, identity, roleIds?, invitedBy?, createdAt? })` | One membership per identity per organization. Roles must belong to that organization. |
| `findByIdentity(organizationId, identity)` / `findById(id)` | |
| `search({ organizationId?, query?, identity?, status?, limit?, after? })` / `count(...)` | Keyset on `id`. |
| `searchListing({ ..., rolesPerMember })` | Each row carries a bounded role preview and the total role count. |
| `listByOrganization(organizationId)` | Internal use. |
| `countByRole(roleIds)` / `countByOrganization(ids)` | Batch counts. |
| `assignRole(membershipId, roleId, { expectedVersion? })` / `unassignRole(...)` | Regular roles only; idempotent. Refuses the Owner role and roles of other organizations. With `expectedVersion`, refused (`membership_version_conflict`) if the membership changed since you read it (`Membership.version`). |
| `assignOwnerRole(membershipId, roleId)` / `unassignOwnerRole(...)` | The only way to grant or remove the Owner role. `unassignOwnerRole` refuses to remove the last Owner. |
| `block(id, { actor, reason?, expectedVersion? })` / `unblock(id, { actor, expectedVersion? })` | Idempotent. The last active Owner can't be blocked (`last_owner`). `unblock` lifts both a block and a suspension. |
| `suspend(id, { actor, until, reason? })` | Like `block`, but only until `until` (a future date, else `membership_block_until_invalid`). The status is `suspended` meanwhile (`blocked.until` has the date); from that instant it reads `active`, `blocked` disappears, and `can()`, snapshots and the SQL functions allow it again. Nothing runs at that moment, so the automatic reactivation has no audit entry (`membership.suspended` records `until`). Blocking someone already blocked, or suspending someone already blocked or suspended, changes nothing (`unblock` first to change the reason or the date) — except that `block` on a suspended member turns the suspension into an indefinite block, so a block never ends sooner than the suspension it replaces; `until` can't be after the year 9999. A suspension that already ended counts as not blocked. The clock is the database's (`now()`) on PostgreSQL and the process's on SQLite and the in-memory storage; keep application servers on NTP. An Owner who can still act can't be unassigned, deleted or leave while every other Owner is blocked or suspended (`last_owner`). A blocked or suspended member can't `leaveOrganization` or receive `transferOwnership` (`membership_blocked`). |
| `recordActivity(id, at?)` | Moves `lastActiveAt` forward for a "last seen" column. |
| `delete(id)` | Refuses to delete the last Owner. |

### Ownership helpers

```ts
await transferOwnership(storage, { organizationId, fromMembershipId, toMembershipId, actor }); // atomic, audited
await leaveOrganization(storage, { organizationId, identity });                                // the last Owner can never leave
```

Neither authorizes the caller. Guard them with a strong permission of your own.

### Members with profiles

UNIORA only knows `(provider, subject)`; to show a person (Studio, your admin pages) it stores their **display name, e-mail and avatar
URL** in `storage.profiles`. It is global per identity, display data only (no authorization decision reads it) and not audited.

```ts
await storage.profiles.upsert(identity, { displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://…/ana.png" });
await storage.profiles.upsert(identity, { avatarUrl: null }); // a field left out is KEPT, `null` clears it
const stored = await storage.profiles.findMany(identities);   // at most MAX_PROFILE_BATCH; unknown identities are absent
```

Values are trimmed and capped; an avatar must be an `http(s)` URL (a `data:` or `javascript:` URL, or an object, is dropped).

**Keep it up to date from your auth provider.** The [identity adapters](identity-adapters.md#profiles) turn their user into a profile
(`toProfile`), and `createProfileSync` stores it where you already resolve the caller. Members who joined before profiles existed fill
themselves in the first time they make a request, with no migration:

```ts
const syncProfile = createProfileSync(storage, { onError: (error) => logger.warn(error) });

const session = await resolveIdentityWithProfile(supabase, accessToken); // verifies once: { identity, profile } | null
if (session) await syncProfile(session.identity, session.profile);        // never throws; skips an unchanged profile for 15 min
```

**Find a person by name or e-mail.** `storage.profiles.search({ query, limit? })` returns the profiles whose name or e-mail contains the
text (case-insensitive, literal), and `memberships.searchListing` / `search` / `count` accept `orIdentities` (used only with `query`) to
ADD those identities to what the term matches by id. `listMembersWithProfiles` does both for you when you pass a `query`.

```ts
const found = await storage.profiles.search({ query: "gómez" });
const members = await storage.memberships.searchListing({ organizationId, query: "gómez", orIdentities: found.map((p) => p.identity), rolesPerMember: 3 });
```

**In Express and Next it is one option.** `requirePermission(engine, "x.y", { resolve, syncProfile })` (Express: `resolve` returns
`{ identity, organizationId, profile }`) and `assertCan(engine, input, { syncProfile, profile })` / `authorizeRoute(engine, input, { syncProfile, profile })`
(Next) store the caller's profile on every request, new or long-standing, with no other code.

`listMembersWithProfiles(storage, resolver, { organizationId, rolesPerMember, ... })` adds `profile { displayName, email, avatarUrl }` to
each listed member: the stored profile (one `findMany` per page) and, if you pass a `resolver`, what `resolver.resolveProfiles(identities)`
returns (one call per page, at most `MAX_PROFILE_BATCH` = 200 identities), which wins field by field. You implement the resolver against
your own users table or provider. A failing store or resolver never breaks the listing (`onResolveError` reports it).

---

## Roles: `storage.roles`

```ts
const role = await storage.roles.create({ id, organizationId, name: "Billing manager", permissionKeys: ["invoices.read"] });
await storage.roles.setPermissions(role.id, ["invoices.read", "invoices.write"]); // atomic replace → { granted, revoked }
const copy = await storage.roles.clone(role.id, { id: newId, name: "Billing (EU)" });
await storage.roles.delete(role.id, { members: { reassignTo: otherRoleId } });
```

| Method | Purpose |
| --- | --- |
| `create({ id, organizationId, name, key?, description?, permissionKeys?, isSystem? })` | Name up to 100 characters, unique per organization ignoring case, accents, extra spaces and Latin/Cyrillic/Greek look-alikes ("Recepción" = "recepcion"; a Cyrillic "Оwner" collides with "Owner"; `normalizeRoleName` gives that form — `role_exists`), with no invisible or bidirectional-control characters (`role_name_invalid`); key like `billing-manager` (`owner` is reserved: `role_key_reserved`). Permissions must be registered. |
| `createOwnerRole({ id, organizationId })` | The only way to make an Owner role. One per organization. Normally called by `createOrganizationWithOwner`. |
| `findByIds(ids)` / `findSummariesByIds(ids)` | Summaries skip permission lists. |
| `listByOrganization(organizationId)` | Internal use. |
| `search({ organizationId, query?, heldBy?, notHeldBy?, isOwnerRole?, isSystem?, limit?, after? })` / `count(...)` | `heldBy` / `notHeldBy` take a membership id. |
| `grantPermission` / `revokePermission(roleId, key)` | Not for the Owner role. |
| `setPermissions(roleId, keys, { expectedVersion? })` | Exactly this list, atomically. Unregistered key: `role_permission_invalid`, nothing changes. With `expectedVersion`, refused (`role_version_conflict`) if the role changed since you read it. |
| `rename(roleId, name)` / `update(roleId, { name?, description?, expectedVersion? })` | Owner and system roles keep their name; a system role's description can change. The new name follows the same uniqueness rule as `create`. |
| `clone(roleId, { id, name, key?, organizationId?, description? })` | A custom copy, never a system role. Can't clone the Owner role. |
| `delete(roleId, { members?: "detach" \| "reject" \| { reassignTo } })` | Default `detach`. `reject` fails with `role_in_use` while someone holds it. Not for Owner or system roles. |
| `countPermissions(ids)` / `countByOrganization(ids)` / `grantedPermissionKeys(roleId, keys)` / `grantingRoles(membershipId, keys, perKey)` | UI helpers: counts and "why does this member have this permission". |

### Role templates

```ts
import { applyRoleTemplates } from "@uniora/core";

const templates = [
  { key: "viewer", name: "Viewer", permissionKeys: ["vehicles.read"] },
  { key: "manager", name: "Manager", permissionKeys: ["vehicles.read", "vehicles.write"] },
];
const { created, synced, skipped } = await applyRoleTemplates(storage.roles, organization.id, templates);
```

Idempotent. Creates missing system roles, re-syncs system roles whose template changed, and leaves alone a custom role a tenant made under the same key (`skipped`). Pass `newId` for your own id scheme.

Options:

- `mode: "create-missing"` only creates what is missing and never changes an existing role (whoever made it), so an Owner's edits to a system role's permissions or description survive; the untouched system roles come back in `unchanged`. The default, `"sync"`, overwrites them as before.
- A template whose `key` or name is already used by a tenant's role no longer stops the others: it is reported in `conflicts` (`{ key, reason: "key_taken" | "name_taken" }`) and the rest are still applied.
- `continueOnError: true` records any other failure in `failed` (`{ key, error }`) and carries on instead of throwing. Use it on the plain repositories, not inside a PostgreSQL transaction (a failed statement aborts the whole transaction).

---

## Permissions: `storage.permissions`

```ts
await storage.permissions.register({ key: "appointments.write", name: "Edit appointments", group: "Appointments", implies: ["appointments.read"] });
```

| Method | Purpose |
| --- | --- |
| `register({ key, name?, description?, group?, implies? })` | **Full upsert**: re-registering without `group` or `implies` clears them. Implied keys must already exist. |
| `findByKey(key)` / `list()` | |
| `search({ query?, group?, grantedToRole?, grantedToMember?, limit?, after? })` / `count(...)` | Keyset on `key`. |
| `countRoleGrants(keys)` | How many roles hold each key. |
| `impliedBy(key)` / `expand(keys)` | The implication closure, for role editors. |
| `unregister(key)` | Refused while granted to a role (`permission_in_use`) or implied by another (`permission_has_dependents`). |

Key: `^[a-z0-9_]+(\.[a-z0-9_]+)+$`, up to 150 characters. Name up to 100.

---

## Features: `storage.features`

```ts
await storage.features.register({ key: "advanced_reports", name: "Advanced reports", defaultEnabled: false });
await storage.features.register({ key: "export_pdf", name: "PDF export", parentKey: "advanced_reports" });
await storage.features.setMany(orgId, { advanced_reports: true, export_pdf: true }, { actor, reason: "Pro plan" });
const effective = await storage.features.listEffective(orgId); // [{ key, enabled, reason, … }]
```

| Method | Purpose |
| --- | --- |
| `register({ key?, name, description?, defaultEnabled?, parentKey? })` | **Full upsert**; the key is derived from the name when omitted. |
| `enable` / `disable(organizationId, key, meta?)` | An explicit override. Unknown key: `feature_unknown`. `meta` is `{ actor?, reason?, expectedVersion? }`; `expectedVersion` is the override's `version` (0 = no override yet) and a stale one fails with `feature_version_conflict`. |
| `setMany(organizationId, { key: boolean }, meta?)` | Atomic: all or nothing. |
| `disableEverywhere(key, meta?)` | Kill switch: every override off, default off. `meta.reason` is also kept on the feature (`FeatureDefinition.reason` and `updatedAt`) and `listEffective` returns it as `defaultReason` / `defaultUpdatedAt` for the organizations without an override. |
| `isEnabled(organizationId, key)` | Effective answer. Unknown key is `false`. |
| `listEffective(organizationId, { keys? })` / `listEffectiveMany(organizationIds, { keys? })` | With the reason; many accepts up to 500 organizations. |
| `enabledKeys(organizationId, keys)` | Which of the keys are on. |
| `listByOrganization(organizationId)` | Explicit overrides only. |
| `listCatalog()` / `search({ query?, enabledIn?, limit?, after? })` / `count(...)` | |
| `summarizeUsage(keys, sampleSize)` / `countEnabledByOrganization(ids)` | Admin-screen aggregates. |
| `unregister(key)` | Removes the definition and the overrides left switched off. Refused while enabled somewhere (`feature_in_use`) or a parent (`feature_has_children`). To retire a feature in one call, see [Retiring a feature](#retiring-a-feature-retirefeature) below. |

```ts
await storage.features.disableEverywhere("legacy_exports", { actor, reason: "Retired; use the new export." });

const feature = (await storage.features.listEffective(orgId)).find((f) => f.key === "legacy_exports");
if (feature && !feature.enabled && feature.reason === "default") {
  showUnavailable(feature.defaultReason ?? "This feature is not available."); // why, and `feature.defaultUpdatedAt` for when
}
```

Re-registering a feature keeps the kill switch's reason while `defaultEnabled` stays off and clears it when `defaultEnabled` is `true`.

### Retiring a feature: `retireFeature`

**What it is for.** A feature you stop offering (its code is gone, or the plan that sold it) has to leave the catalog, or its row keeps showing up in Studio and in every `listCatalog` / `listEffective` for nothing. `features.register` only adds, and `unregister` refuses while the feature is on anywhere, so retiring used to be "`disableEverywhere`, then `unregister`, and handle both errors". `retireFeature(storage, key, options?)` does both in **one transaction** and is **idempotent**, so an app can run it on every start for the keys it dropped from its code (a `features:sync` script).

**Requirements.** `@uniora/core` 1.2.0 or later; any storage (memory, PostgreSQL, SQLite). No migration. It does not authorize the caller: guard it with `engine.can`, or run it from your own deploy script.

```ts
import { retireFeature } from "@uniora/core";

const result = await retireFeature(storage, "setup_tutorial", {
  disableEverywhere: true,          // also switch it off where it is still on
  actor: { provider: "main", subject: "deploy-bot" },
  reason: "Removed from the product",
});
// { retired: true, disabledOverrides: 3, defaultWasEnabled: false }
await retireFeature(storage, "setup_tutorial", { disableEverywhere: true }); // { retired: false, … } — already gone, no error
```

**Rules that surprise.**

- Without `disableEverywhere`, a feature that is still **effectively on** in some organization is refused (`feature_in_use`) and nothing changes: turning something off for customers is a decision, so it is explicit. With it, the kill switch (`features.disableEverywhere`, with your `actor` / `reason`) runs first.
- Overrides that were already **off** (for instance organizations an admin or your billing switched it off for) are not rewritten: they disappear together with the definition, because there is nothing left for them to refer to. Nothing else about those organizations changes.
- Another feature that names it as `parentKey` blocks the retirement (`feature_has_children`): retire or detach the children first. Because it is one transaction, a refusal also undoes the kill switch.
- A key that does not exist is not an error: `{ retired: false, disabledOverrides: 0, defaultWasEnabled: false }` and nothing is audited. A typo is therefore silent; check the returned `retired` if that matters.
- With `createAuditedStorage`, the audit log gets `feature.disabled_everywhere` and `feature.unregistered` (see [Audit log](audit-log.md)).

**Errors.** `feature_in_use`, `feature_has_children` ([Errors](errors.md)).

**Studio and the HTTP API.** Studio's feature catalog already has "Unregister" (same refusals as `unregister`). There is no HTTP route for it: the HTTP API has no write route for the feature catalog at all (the catalog is declared by your application's code with `features.register`, not by API clients), so adding only "retire" would be one-sided; `openapi.json`, `server-api.md` and `@uniora/client` do not change.

**Adopting it.** Upgrade `@uniora/core`, and replace your `disableEverywhere` + `unregister` pair (or your hand-made SQL `delete`) with `retireFeature`. Do **not** delete rows from `uniora.feature_definitions` by hand: the `retireFeature` / `unregister` path is the one that checks children and audits.
This needs migration Postgres `0047` / SQLite `0032` (`uniora migrate`).

Key: lowercase alphanumerics separated by underscores, up to 63 characters.

---

## Entitlements, support grants, outbox

Documented in their own guides: [entitlements](entitlements.md) (`storage.entitlements`: `define`, `setLimit`, `clearLimit`, `get`, `list`, `consume`, `release`),
[support grants](support-grants.md) (`storage.supportGrants`: `create`, `revoke`, `findById`, `search`, `count`, `activePermissions`) and
[outbox](outbox.md) (`storage.outbox`, `dispatchOutbox`) and [teams](teams.md) (`storage.teams`, `storage.teamMemberships`).

---

## Invitations

`createInvitationService({ storage, acceptUrl, sender?, ttlMs?, rateLimits?, retry?, … })`. See [Invitations](invitations.md).

---

## Identity links: `storage.identityLinks`

| Method | Purpose |
| --- | --- |
| `link({ from, to, actor })` | `from` (the new identity) will resolve to `to` (the one that owns the memberships). Self-audits. Verify both identities first. |
| `unlink({ from, actor })` | `false` if there was no link. Self-audits. |
| `resolve(identity)` | The identity to use for lookups (the identity itself when unlinked). |

---

## Audit log: `storage.auditLogs`

`record`, `listByOrganization`, `listRecent`, `search`, `pruneBefore`, `verifyIntegrity`, plus `applyAuditRetention` and `AUDIT_ACTIONS`. See [Audit log](audit-log.md).

---

## Storage

`UnioraStorage` is the set of repositories above plus `transaction(callback)`. `createMemoryStorage()` is an in-memory implementation for tests;
`@uniora/postgres` and `@uniora/sqlite` are the real ones ([Storage](storage.md)). Inside `transaction`, use the `tx` you are given, never the outer `storage`:

```ts
await storage.transaction(async (tx) => {
  await tx.memberships.assignRole(membershipId, roleId);
  await tx.outbox.enqueue({ id: crypto.randomUUID(), type: "plan.changed", organizationId, payload: { membershipId } });
}); // all or nothing
```

## Identity

`Identity = { provider: string; subject: string }` and `sameIdentity(a, b)`.
