# Platform administrators

Organizations have owners and roles. A **project** also needs people who administer the whole thing: the developers and support
staff of the product built on UNIORA, who suspend an organization, read the platform audit trail or open temporary access to a
customer's data. That power must not live in any organization, so UNIORA keeps it in a **separate scope**: the platform.

> The platform is not an organization with special rules. It has its own tables, its own roles, its own permissions, its own
> engine and its own service. Nothing in an organization (an Owner, a role, a team, a support grant) can create, reach or change
> platform power, and platform power gives nothing inside an organization by itself.

UNIORA gives you the engine, not a panel: build your own admin app on top of it (Studio stays a local tool).

## The model

- **Platform permissions** are keys under `platform.` (`platform.organizations.manage`). A key ending in `.*` covers everything under that
  prefix (`platform.organizations.*`). `platform.*` (everything) exists only on the system role. You can define your own keys
  (`platform.billing.refund`) and check them with `platformEngine.can`.
- **Platform roles** are named sets of those keys, defined by you. UNIORA creates one itself, the system role **Platform Administrator**
  (`platform_admin`, `platform.*`); it cannot be edited or deleted.
- **Platform members** are identities (provider + subject, exact; no identity link is ever followed) with one or more platform
  roles and a status (`active`, `suspended`).
- **The same person can be a platform member and an organization member** (even its Owner) at once. What is isolated is the power,
  not the people: each scope answers only from its own tables.

| UNIORA ships | Does |
| --- | --- |
| `createPlatformEngine(storage)` | `can({ identity, permission })`, `permissionsOf(identity)`, `assertCan`. Fail-closed. |
| `createPlatformService({ platform, storage? })` | The only way to change roles and members, and to act on organizations. |
| `bootstrapPlatform({ platform, admin })` / `uniora platform init` | Creates the first Platform Administrator, once. |
| `runPlatformCommand`, `platformCommand` (Express), `platformCommandRoute` (Next) | A fixed, validated door for your admin routes. |

## Set it up

```bash
npx uniora migrate                                    # Postgres 0037 (schema uniora_platform), SQLite 0022
npx uniora platform init --admin supabase:3f2c9a10-…  # the first Platform Administrator; works once
npx uniora platform status                            # read-only
```

```ts
import { createPlatformEngine, createPlatformService } from "@uniora/core";
import { createPostgresPlatformStorage } from "@uniora/postgres"; // or createSqlitePlatformStorage / createMemoryPlatformStorage

const platform = createPostgresPlatformStorage(platformPool);    // its own pool, ideally its own database user
const engine = createPlatformEngine(platform);
const admin = createPlatformService({ platform, storage });      // `storage` (UnioraStorage) only for organization operations

// In YOUR admin app, after YOUR authentication (a different session from the one customers use):
if (!(await engine.can({ identity, permission: "platform.billing.refund" }))) return forbidden();

const role = await admin.createRole({ actor: identity, key: "support", name: "Support", permissions: ["platform.organizations.read", "platform.support.grant"] });
await admin.addMember({ actor: identity, identity: { provider: "supabase", subject: "…" }, roleIds: [role.id] });
await admin.setOrganizationStatus({ actor: identity, organizationId, status: "suspended", reason: "Unpaid invoice" });
await admin.grantSupportAccess({ actor: identity, organizationId, permissions: ["reports.read"], reason: "Ticket 4821", expiresAt });
```

## The rules (enforced by the service, and the important ones by the storage)

1. **Nobody grants themselves power.** You cannot add, suspend, remove or change the roles of yourself (`platform_self_change`).
2. **No escalation.** You can only create or edit a role, assign a role, or act on a member using permissions you hold yourself; a member who holds more than you is out of reach (`platform_escalation`). Only the system role carries `platform.*`.
3. **The platform always has an administrator.** The last active Platform Administrator cannot be suspended, demoted or removed (`platform_last_admin`). The databases enforce this with triggers (an advisory lock in Postgres), so it holds against any SQL client, and two administrators suspending each other at the same instant leave one.
4. **The storage refuses writes that did not come from the service.** Every write of platform roles and members needs a single-use authorization (60 s, bound to the actor and the operation) that only the service and the one-time bootstrap can issue, as with Teams. A forged, copied or expired one is refused (`platform_authorization_required`). There is no "trusted storage" shortcut.
5. **Organizations cannot reach it.** The tables are in their own schema; `UnioraStorage` has no platform repositories, so code that serves organizations never holds them. Give the platform schema to its own database role (see `guides/sql/least-privilege-roles.sql`).
6. **Everything is audited**, with the real actor, as global entries (`platform.*`) in the audit log, in the same transaction as the change. Organization operations (`organization.status_changed`, `support_grant.created`) also land in that organization's own trail.
7. **Support access is for yourself, temporary and narrow.** `grantSupportAccess` opens a support grant whose operator is always the actor (30 days at most, never the Owner role), and needs `platform.support.grant`.
8. **Step-up.** Pass `stepUp({ actor, operation })` to `createPlatformService` to demand a recent re-authentication (MFA) before any change; it answers `platform_step_up_required` (HTTP 428). Reads are not asked.

## Built-in permissions

| Key | Lets you |
| --- | --- |
| `platform.roles.read` / `platform.roles.manage` | list / create, edit and delete platform roles (within your own permissions) |
| `platform.members.read` / `platform.members.manage` | list / add, suspend, reactivate, remove members and change their roles (never above your own) |
| `platform.organizations.read` / `platform.organizations.manage` | list organizations / suspend, archive and reactivate them |
| `platform.support.grant` | open and end support access for yourself |
| `platform.audit.read` | reserved for your audit viewer |

## Recommended setup

- Run the admin app apart from the customer app, with its own authentication and, if you can, its own database user for the platform pool.
- Keep two or three Platform Administrators, and give daily work to narrower roles (`support`, `billing_ops`).
- Turn on `stepUp`, anchor the audit head (see [hardening](hardening.md)) and alert on `platform.*` entries.
- Do not put a platform identity on an organization role "to make things easier": use a support grant when someone really needs to see customer data.

## Limits

- The platform is flat on purpose: roles are sets of permissions, there is no hierarchy or inheritance between roles.
- Identities are exact. If you have several auth providers, add each identity that should have power.
- Wiping the platform (no administrators left) is a database operation (truncate the `uniora_platform` tables, then `uniora platform init`), not a service call: that is the root of trust.
