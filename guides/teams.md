# Teams

Teams are the organizational structure of an organization: departments, branches, regions, projects, stores, a temporary task force.
UNIORA does not decide what a team means; your application does. It provides the infrastructure (groups, memberships, lifecycle,
audit) and keeps the rule that makes it safe:

> Roles say what a person may do, permissions say which actions, features say which capabilities exist, **teams say in which
> organizational context a person operates**, and the authorization engine decides.

A team is **context, not authority**. Being a member, a manager or the owner of a team opens nothing by itself.

## The model

- A team belongs to **one** organization, forever. `slug` and `externalId` are unique inside it, never globally. Every repository method that takes a team id also takes the organization id, and a team of another organization behaves exactly like a team that does not exist (`team_not_found`). On the database backends the same guarantee is enforced by composite foreign keys.
- A **team membership** links an organization membership to a team. It is independent of the organization membership: a member can belong to no team, to one, or to several. Deleting the organization membership removes their team memberships.
- Team membership **status**: `pending` (invited, not accepted) → `active` → `suspended` → `removed`. Only the invited person can accept (`accept`, `team_accept_forbidden` for anyone else); `setStatus` cannot move `pending` to `active`. A removed row stays for the record and a later `add` reuses it. `pending`/`active`/`suspended` can also go straight to `removed`.
- **Responsibility** (`owner`, `manager`, `member`) is a label that says who looks after the team. It is not a permission and nothing in UNIORA grants anything because of it.
- **Team roles**: a team membership can hold roles of the same organization (`roleIds`) that apply inside that team only (Juan is a Manager in Barcelona and a plain member in Madrid). The organization's Owner role can never be held this way. Removing someone from a team drops their roles there.
- **Lifecycle**: `active` → `archived` (kept for the record, no changes, no new members) → `restore`, or `delete` (only an archived team; it removes its team memberships, never the audit trail).
- **Hierarchy (optional)**: `parentId` nests a team under another **active** team of the same organization (a branch inside a region, a squad inside a department), at most 8 levels deep and never in a loop (`team_parent_invalid`, `team_cycle`, `team_too_deep`). It is organizational only: a parent grants and inherits nothing, `can({ teamId })` never looks at it, and belonging to a parent says nothing about its sub-teams. `teams.ancestors(organizationId, id)` (top-level team first), `teams.descendants(organizationId, id)` and `search({ organizationId, parentId })` (`null` = top-level teams) read the tree; `update({ parentId })` moves a team with everything below it, `parentId: null` makes it top-level. A team with active sub-teams cannot be archived, one with any sub-team cannot be deleted (`team_has_children`), and a team cannot be restored under an archived parent. On the databases `parent_id` has a foreign key that includes the organization (Postgres) or a trigger that refuses a parent of another organization (SQLite).
- **Metadata and settings**: free-form JSON objects (at most 16 KB, plain JSON, 8 levels) that UNIORA stores and never interprets. `externalId` links the team to your ERP, CRM or HR system.

```ts
const audited = createAuditedStorage(storage, { actor: adminIdentity });

const barcelona = await audited.teams.create({
  id: crypto.randomUUID(),
  organizationId,
  name: "Barcelona",                       // slug "barcelona" is derived unless you pass one
  externalId: "branch_348",
  metadata: { type: "branch", country: "ES", costCenter: "ES-BCN-01" },
});

// Add an organization member directly, or invite them (they accept later):
const row = await audited.teamMemberships.add({
  id: crypto.randomUUID(),
  organizationId,
  teamId: barcelona.id,
  membershipId,
  status: "pending",                       // omit for "active"
  responsibility: "manager",
  roleIds: [salesRoleId],
  invitedBy: adminIdentity,
});
await audited.teamMemberships.accept(organizationId, row.id, { actor: memberIdentity }); // only the invited person can accept

await audited.teams.update(organizationId, barcelona.id, { metadata: { type: "branch" }, expectedVersion: barcelona.version });
await audited.teams.archive(organizationId, barcelona.id, { actor: adminIdentity, reason: "branch closed" });
```

Nobody moves between teams by themselves: joining, leaving, promoting or changing roles are separate calls that the host must authorize first, and the database refuses any row that mixes organizations even if someone writes SQL by hand.

Everything is paginated with a keyset cursor (`search({ organizationId, after, limit })`), and `teamMemberships.search({ organizationId, identity })` lists the teams of one person.
`version` / `expectedVersion` work as in the rest of UNIORA (`team_version_conflict`, `team_membership_version_conflict`).

## Changing who is in which team: the team service

The repositories above are low-level (they demand a `TeamAuthorization`, see below). For anything driven by a user, use the **team service**: every
operation asks the authorization engine first, inside the same transaction as the change, and records the actor in the audit log.

```ts
import { TEAM_PERMISSIONS, createTeamService } from "@uniora/core";

const teams = createTeamService({ storage });          // register TEAM_PERMISSIONS in your catalog and give them to roles
await teams.addMember({ actor: session.identity, id, organizationId, teamId, membershipId });   // needs teams.members.add
await teams.moveMember({ actor, organizationId, membershipId, fromTeamId, toTeamId, id });      // needs remove in the source AND add in the destination
```

Rules it enforces (all covered by tests on memory, Postgres and SQLite):

- **Nobody changes team by themselves**: joining a team needs `teams.members.add` even for yourself; `moveMember` needs `teams.members.remove` in the source team and `teams.members.add` in the destination, and you cannot move yourself. Leaving (`leaveTeam`) and declining an invitation are always allowed for your own membership.
- **Each permission is satisfied organization-wide or inside that very team**, never through another team: a lead of Barcelona who holds `teams.members.add` through a Barcelona role cannot add anyone to Madrid.
- **No self-promotion**: you cannot change your own responsibility, give yourself roles or lift your own suspension. Making someone team owner needs `teams.manage`.
- **No escalation through roles**: you can only give a role whose every permission you hold yourself; the Owner role can never be given.
- **Only the invited person accepts** an invitation (`acceptInvitation`).
- **Deleting a team** needs `teams.manage` organization-wide.

### The storage itself refuses unauthorized team changes

Every write of `storage.teams` and `storage.teamMemberships` requires a **`TeamAuthorization`**: an opaque proof that cannot be written by hand. Only the team service (after the engine said yes) and `createTrustedTeamStorage` (below) can issue one. The storage (memory, Postgres and SQLite) checks it before anything else and answers `team_authorization_required` to a missing, forged, copied, expired token, or one issued for another organization, operation or actor. So code that gets hold of `storage` and calls `storage.teamMemberships.add(...)` directly no longer works by accident; it has to go through the service or choose, in plain sight, the trusted wrapper. A custom backend must call `assertTeamAuthorization` in each of those writes (the conformance suite checks it).

For imports, migrations, sync jobs, tests and admin tooling that run as the system, and never in a request handler:

```ts
const system = createTrustedTeamStorage(createAuditedStorage(storage, { actor: jobIdentity }), {
  actor: jobIdentity,
  reason: "nightly sync from the HR system",   // required: why this code may skip the permission check
});
await system.teams.create({ id, organizationId, name: "Barcelona", externalId: "branch_348" });
```

It keeps every other rule (isolation, lifecycle, validation, versions) and the audit trail; it only skips the permission check, which is why it is a separate, greppable function. What remains out of reach for any library is code that runs SQL against your database by hand; even then, the database refuses rows that mix organizations.

### Hierarchy through the service

Creating a sub-team needs `teams.manage` **in the parent team** (or organization-wide), so a regional manager can open branches under their own region and nowhere else; a top-level team needs the organization-wide grant. Moving a team needs `teams.manage` on the team **and** on the destination parent (the organization-wide grant to take it to the top level). Tree changes of one organization are serialized with an advisory lock, so two moves that are fine alone cannot form a loop together.

## Team as context for `can`

```ts
await engine.can({ identity, organizationId, permission: "vehicles.read", teamId: vehicle.teamId });
```

With `teamId` the answer can only get **narrower**: the identity must be an active member of that active team of the organization **and** hold the permission through its organization roles or the roles it holds in that team. A role held in a team never counts outside it. Being team owner or manager grants nothing, the organization's Owner role does not skip the membership check, and a support grant does not apply. Unknown or foreign teams, archived teams, and pending, suspended or removed members are denied. `engine.access.check({ identity, organizationId, teamId })` answers "is an active member of this team". Which team a resource belongs to is your data; UNIORA only evaluates the context you pass.

## What UNIORA does not do for you

- **The permission catalog.** Register `TEAM_PERMISSIONS` (`teams.manage`, `teams.members.add`, `teams.members.remove`, `teams.members.manage`) and give them to the roles that should manage teams.
- **It does not know your resources.** A vehicle or a ticket belongs to a team because your table says so; you pass that team when you ask the question.
- **No bypass.** There is no code path where an owner or manager of a team skips the engine.

## Audit

With `createAuditedStorage` every change is recorded in the same transaction: `team.created`, `team.updated` (which fields changed; metadata and settings are only flagged, never copied), `team.archived`, `team.restored`, `team.deleted`,
`team_member.added`, `team_member.invited`, `team_member.accepted`, `team_member.reactivated`, `team_member.suspended`, `team_member.removed`, `team_member.role_assigned`, `team_member.role_unassigned`,
and `team.owner_changed` / `team.manager_changed` when the responsibility of a member changes. Calls that change nothing record nothing.

Postgres migration `0034`, SQLite `0019`. A custom backend must implement `teams` and `teamMemberships` (the conformance suite covers them).
