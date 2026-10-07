# Concepts

UNIORA answers one question: **given an identity and an organization, what may this person do, and what has the organization
unlocked?** It does not authenticate anyone and it does not host your data: everything lives in your database.

```text
Auth provider ──> Identity ──> Membership ──> Roles ──> Permissions ──┐
                                   │                                    ├──> engine.can() / access.check()
                          Organization ──> Features (+ entitlements) ──┘
```

## Identity

`{ provider: "supabase", subject: "…" }`. The provider name is yours to choose (the adapters use `supabase`, `clerk`, `auth0`,
`better-auth`); the subject is the provider's stable user id. UNIORA stores identities, never passwords or tokens.

**Identity links** (`storage.identityLinks`) let one person keep their organizations when they change provider:
`link({ from: newIdentity, to: oldIdentity, actor })` makes the new identity resolve to the old one, so `engine.can` finds the
old memberships. Only link two identities after you have verified, in one session, that the same person controls both: UNIORA
cannot check that. A link is refused (never merged silently) when `from` already has a membership of its own, is already linked to
another identity, would form a chain, or points to itself. `unlink({ from, actor })` removes it, and both operations audit themselves.

## Organization

The tenant. It has an `id`, a `name`, a unique URL-safe `slug` and a `status`:

| Status | Effect |
| --- | --- |
| `active` | Normal. |
| `suspended` | The engine, snapshots and the SQL functions for RLS deny **everyone**, the Owner included. Data is untouched. |
| `archived` | Same as suspended, meant as "closed". |

Setting the status back to `active` restores everything. There is **no hard delete** on purpose: the audit log references its
organization and must outlive it, so you archive (see the [roadmap](roadmap.md)). Renaming changes `name` only; `update` can
change the `slug` too, and slugs are unique across organizations.

## Membership

The link between an identity and an organization, with the roles that person holds there. One identity has at most one
membership per organization. A membership is `active` or `blocked`: a blocked member keeps their roles but is denied everything,
Owner included, and the last active Owner can't be blocked. A member can also be `suspended` until a date (`suspend(id, { actor, until })`): denied like a blocked one, then `active` again by themselves when the date passes, with no job to run. Memberships also record who invited them and when they were last active.

## Roles and the protected Owner

A role belongs to **one** organization and carries a list of permission keys. Roles are custom (a tenant makes their own) or
**system** roles (`isSystem`: defined by your code through templates; they can't be renamed or deleted, their permissions can change).

Every organization has exactly one **Owner role**. It is created together with the organization and:

- passes every permission check, whatever `permissionKeys` says (set `ownerRequiresRegisteredPermission` on the engine to limit that to registered keys, so a typo is denied for the Owner too);
- can't be granted by `assignRole` or by an invitation, only by `assignOwnerRole` or `transferOwnership`;
- can't be left without a holder: removing, blocking or demoting the last active Owner fails, enforced in the database, so two simultaneous requests can't both succeed.

## Permissions

A key such as `vehicles.delete`: lowercase segments joined by dots, at least two (`^[a-z0-9_]+(\.[a-z0-9_]+)+$`, up to 150 characters).
The catalog (`storage.permissions`) is global and shared by all organizations; roles grant keys from it.

- **Groups** (`group: "Vehicles"`) organize the catalog for a role editor.
- **Implications** (`implies: ["appointments.read"]` on `appointments.write`): a role holding the bigger permission passes for everything it implies, through the chain (at most 8 levels, 20 per permission, no cycles).

## Features

Per-organization switches ("has this organization unlocked advanced reports?"). Keys are lowercase with underscores
(`advanced_reports`, up to 63 characters).

- A feature can be **on by default** (`defaultEnabled`); an override per organization wins.
- A feature can have a **parent**: turn the parent off and its children are off too (`listEffective` tells you why: `enabled`, `disabled`, `default`, `parent_disabled`).
- `disableEverywhere(key)` is the kill switch.

## Entitlements

Features are on/off. **Entitlements** are counted limits ("25 seats", "20 reports per month"). UNIORA counts and refuses
atomically; you decide each organization's limit from your own billing data. See [entitlements](entitlements.md).

## The engine: deny by default

```ts
const engine = createAuthorizationEngine(storage, options);
engine.can({ identity, organizationId, permission });                 // permission only
engine.access.check({ identity, organizationId, permission, feature }); // permission and/or feature
```

`can` is `true` only when all of this holds:

1. the permission key is well formed;
2. the organization exists and is `active`;
3. the identity (or the identity it is linked to) has an `active` membership in **that** organization;
4. one of the member's roles, belonging to **that** organization, holds the permission, implies it, or is the Owner role.

A temporary [support grant](support-grants.md) can stand in for step 3 and 4 for a platform operator who is not a member.

`access.check` additionally requires the feature to be effectively enabled, and a check with only a `feature` still requires real
membership: a feature switch alone never lets a stranger in. A malformed key (empty, not a string) is denied for everybody.

`onDecision` receives every decision, allowed or denied, so you can keep your own trail; an error inside the hook never changes a decision.

### Snapshots for the browser

`computeAuthorizationSnapshot(engine, storage.features, { identity, organizationId, permissions, features })` resolves a **bounded**
list of keys into plain JSON the server sends to the UI. The client never queries UNIORA; hiding a button is UX, and the server must
still authorize the real operation. See [Frameworks](frameworks.md#react).

## Who authorizes the caller?

You do. `engine.can` answers questions; the repositories and helpers (`roles.update`, `memberships.assignRole`,
`transferOwnership`, `invitations.invite`, …) perform the change without asking who is calling. Put an engine check in front of
each, with a permission you register for the purpose (we suggest `members.invite`, `roles.assign`, `organization.transfer_ownership`).

## Audit log

Every change made through `createAuditedStorage` writes an entry in the same transaction: actor, action (`membership.blocked`,
`role.updated`, …), target and metadata. The log is append-only and hash-chained, so editing or deleting a row is detectable.
See [Audit log](audit-log.md).

## Where each thing lives

| Concept | Repository | Package |
| --- | --- | --- |
| Organizations | `storage.organizations` | `@uniora/core` |
| Memberships | `storage.memberships` | `@uniora/core` |
| Roles | `storage.roles` | `@uniora/core` |
| Permissions catalog | `storage.permissions` | `@uniora/core` |
| Features | `storage.features` | `@uniora/core` |
| Entitlements | `storage.entitlements` | `@uniora/core` |
| Support grants | `storage.supportGrants` | `@uniora/core` |
| Invitations | `storage.invitations` (use `createInvitationService`) | `@uniora/core` |
| Identity links | `storage.identityLinks` | `@uniora/core` |
| Audit log | `storage.auditLogs` | `@uniora/core` |
| Events after commit | `storage.outbox` | `@uniora/core` |

`@uniora/core` defines these contracts; `@uniora/postgres`, `@uniora/sqlite` and `createMemoryStorage()` implement them.
