# Delegated administration: who may give which power to whom

The repositories (`memberships.assignRole`, `roles.setPermissions`, `invitations.create`, …) perform a change without asking who is
calling, and say so: "the host decides". That is fine while only the Owner administers members. The day you let anyone else do it
(a team lead who invites people, an HR manager who assigns roles), you need four rules, and writing them yourself is where
privilege-escalation bugs are born. UNIORA ships them once, tested on memory, SQLite and Postgres, as a sibling of the
[team service](teams.md):

1. **No escalation.** You can only give what you hold yourself. A role only if you hold **every** permission in it; a permission
   only if you hold it. Same for offering a role in an invitation and for putting permissions into a role. (The Owner holds everything.)
2. **Nobody changes their own roles.** No giving yourself a role, taking one off, blocking or removing yourself. (Leaving is `leaveOrganization`.)
3. **You do not touch whoever holds more power than you.** A member (or a role) is within reach only if every permission they hold is
   also yours, implications included. An Owner can only be touched by an Owner.
4. **The Owner role stays out.** It moves only through `assignOwnerRole` / `unassignOwnerRole` / `transferOwnership`.

"More power" is a comparison of permission **sets**, not a ranking: two administrators with different permissions cannot touch each
other, and two with the same permissions can. Editing or deleting a role needs the role to be within your reach; the people who hold
it are not scanned (a role can have millions of holders).

## Set it up

```ts
import { createAccessAdminService, createGuardedStorage, createInvitationService } from "@uniora/core";

// Build the guarded storage ONCE and hand only it to the rest of your code. Keep the plain storage private.
const storage = createGuardedStorage(createPostgresStorage(pool));

const access = createAccessAdminService({ storage });
const invitations = createInvitationService({ storage, acceptUrl, sender });   // enforces the rules by itself on a guarded storage
```

Register the permission keys and give them to the roles that should administer members (override any key with `permissions`):

| Key (`ACCESS_PERMISSIONS`) | Needed for |
| --- | --- |
| `members.roles.manage` | `assignRole`, `unassignRole` |
| `members.invite` | `invite`, `resend`, `revoke` of the invitation service |
| `members.block` | `blockMember`, `suspendMember`, `unblockMember` |
| `members.remove` | `removeMember` |
| `roles.manage` | `createRole`, `updateRole`, `setRolePermissions`, `grantRolePermission`, `revokeRolePermission`, `cloneRole`, `deleteRole` |

```ts
await access.assignRole({ actor: session.identity, organizationId, membershipId, roleId });   // Promise<Membership>
await access.setRolePermissions({ actor, organizationId, roleId, permissionKeys: ["reports.read"], expectedVersion });
await invitations.invite({ organizationId, email, roleIds: [viewerId], invitedBy: session.identity });
```

`actor` is always your authenticated caller, never something from a request body. Each operation, in this order: asks the
authorization engine for its permission (`access_forbidden` if the answer is no, with no trace in the log); takes an advisory lock on
the organization, so two changes of power never interleave and a decision still holds when it is written; applies the rules above;
issues an `AccessAuthorization` and writes through the audited storage, so the change is recorded with the actor in the **same
transaction**. A rule that stops someone who had the permission also leaves an `access.change_refused` entry (`operation` and `code`).

Errors are `AccessError`s with stable codes: `access_forbidden` (no permission), `access_self_change` (rule 2),
`access_escalation` (rule 1), `access_target_stronger` (rule 3), `access_owner_protected` (rule 4), `access_invalid`, and the two
programming errors `access_authorization_required` and `access_storage_not_guarded`. A member or role of another organization is
`membership_not_found` / `role_not_found`, exactly as if it did not exist. The usual repository errors still apply (`last_owner`,
`membership_version_conflict`, …).

## The storage refuses unauthorized changes

`createGuardedStorage(storage)` wraps any `UnioraStorage` (memory, Postgres, SQLite, your own) so that **every write that decides who
holds which power** needs an `AccessAuthorization`, an opaque proof that cannot be written by hand:

`memberships.assignRole`, `unassignRole`, `assignOwnerRole`, `unassignOwnerRole`, `create` (when it carries roles), `block`, `suspend`,
`unblock`, `delete`; `roles.create`, `clone`, `rename`, `update`, `grantPermission`, `revokePermission`, `setPermissions`, `delete`;
`invitations.create`, `rotateToken`, `revoke` (`GUARDED_WRITES` lists them). Reads and every other write pass through.

A token names **one operation on one target** ("give role R to membership M"), works **once**, and expires after 60 seconds, so a token
that leaks in a log line cannot be replayed or pointed at something else. Only the access service and the invitation service (after the
rules passed), the library's own founding flows and the trusted wrapper below can issue one. Code that gets hold of the guarded storage
and calls `storage.memberships.assignRole(...)` directly gets `access_authorization_required`.

The guard lives in `@uniora/core`, above the backend, so a custom backend gets it for free. Its limit is the obvious one: whoever holds
the **plain** storage (or runs SQL by hand) is not stopped. That is why you build the guarded storage once and keep the other private.
The services refuse an unguarded storage (`access_storage_not_guarded`) unless you pass `allowUnguardedStorage: true`, in which case the
rules still apply to every call of the service but nothing stops other code from skipping them.

### Back-office code: the trusted storage

Imports, migrations, seeding role templates, ownership transfers and tests run as the system. Say so, in plain sight:

```ts
import { applyRoleTemplates, createAuditedStorage, createTrustedAccessStorage, transferOwnership } from "@uniora/core";

const system = createTrustedAccessStorage(createAuditedStorage(storage, { actor: jobIdentity }), {
  actor: jobIdentity,
  reason: "nightly sync from the HR system",      // required: why this code may skip the rules
});
await applyRoleTemplates(system.roles, organizationId, templates);
await transferOwnership(system, { organizationId, fromMembershipId, toMembershipId, actor: jobIdentity });
```

It stamps every guarded write with a trusted token and changes nothing else (isolation, validation, versions, audit). It is named and
documented to be greppable: any use of it in code that answers a user request is a bug in review. Two library flows need no wrapper
because they are not an escalation: `createOrganizationWithOwner` (the founder gets power over nothing that existed) and
`leaveOrganization` (your own membership).

## Invitations

`createInvitationService` follows the same rules when its storage is guarded (default) or when you pass `access: true` / `access: { permissions,
allowUnguardedStorage }`; `access: false` keeps the old "the host authorizes" behaviour (on a guarded storage that only works through a
trusted storage). With it on:

- `invite` needs `members.invite` and every permission of every role offered; the same gate protects the replay of an idempotent request.
- `resend` and `revoke` need `members.invite` and reach over the invitation's roles. Refusals are `AccessError`s; `invitationErrorToHttp` answers `403`.
- **`accept` asks again, at the moment of acceptance, what the inviter can give now.** It gives only the roles they still could (the
  inviter lost the permission, left the organization, or the role grew past them) and reports the rest in `rolesSkipped`; if nothing is left it fails
  with the usual generic `invitation_roles_unavailable` and the invitation stays pending. Nothing is given to the inviter themselves (a
  support operator would otherwise turn a grant into a membership by inviting their own address) nor to an existing member who holds more power than the inviter.
  Invitations created before you turned the rules on are re-checked the same way.

## Over HTTP

`runAccessCommand({ access, invitations }, command, { actor, organizationId }, params)` is the door for request handlers, like
`runTeamCommand`: the command is fixed by the route, the actor and the organization come from your session, every field is checked
and an unknown one (`actor`, `authorization`, `organizationId`) is rejected. `@uniora/express` has `accessCommand(services, { command, resolve })` and
`@uniora/next` has `accessCommandRoute(services, { command, caller, params })`:

```ts
app.put("/orgs/:orgId/members/:membershipId/roles/:roleId", accessCommand({ access }, { command: "assignRole", resolve }));
app.post("/orgs/:orgId/invitations", accessCommand({ access, invitations }, { command: "inviteMember", resolve }));
```

The commands (`ACCESS_COMMANDS`) are `assignRole`, `unassignRole`, `blockMember`, `suspendMember`, `unblockMember`, `removeMember`,
`createRole`, `updateRole`, `setRolePermissions`, `grantRolePermission`, `revokeRolePermission`, `cloneRole`, `deleteRole`,
`inviteMember`, `resendInvitation` and `revokeInvitation`. A caller without the permission gets a plain `403 { "error": "forbidden" }`;
one who has it but was stopped by a rule gets the same `403` with a `reason` (`access_escalation`, …) so your screen can explain it
(`accessErrorToHttp`). `inviteMember` does not return the secret accept link unless the route asks (`includeAcceptUrl`).

## What this does not cover

- **Reading.** Who may list members, roles or invitations is yours to decide.
- **Code that changes the catalog.** `permissions.register({ implies })` widens what every role holding a key can do, and
  `identityLinks.link` lets another identity reach a membership; both are host code with their own trust boundary, not tenant actions.
- **Platform and support access.** Platform administrators have [their own service](platform.md); a [support grant](support-grants.md) gives
  an operator exactly the keys it lists (and the service compares against them too).
- **Holders of an edited role.** Editing a role needs the role to be within your reach; the members who hold it are not scanned.
- **Power is compared as sets of permission keys read from storage.** If a future policy layer adds conditions to the engine's answer,
  those conditions are not part of this comparison.

## Upgrading

Nothing changes until you opt in: the repositories accept an optional `authorization` they ignore, and the invitation service behaves as before on an
unguarded storage. On a guarded storage code that wrote power directly (seed scripts, `applyRoleTemplates`, `transferOwnership`) must move to
`createTrustedAccessStorage` or the services. `AcceptInvitationResult` gains `rolesSkipped` (always empty without the rules). New audit
action `access.change_refused`. No migration.
