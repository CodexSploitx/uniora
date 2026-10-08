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

## What UNIORA does not do for you

- **It does not authorize these calls.** Like `roles.assign` or `memberships.block`, the repositories trust the caller: check with `engine.can` (for example `teams.manage`, `teams.members.invite`) before calling them.
- **It does not know your resources.** A vehicle or a ticket belongs to a team because your table says so; you pass that team when you ask the question.
- **No bypass.** There is no code path where an owner or manager of a team skips the engine.

## Audit

With `createAuditedStorage` every change is recorded in the same transaction: `team.created`, `team.updated` (which fields changed; metadata and settings are only flagged, never copied), `team.archived`, `team.restored`, `team.deleted`,
`team_member.added`, `team_member.invited`, `team_member.accepted`, `team_member.reactivated`, `team_member.suspended`, `team_member.removed`, `team_member.role_assigned`, `team_member.role_unassigned`,
and `team.owner_changed` / `team.manager_changed` when the responsibility of a member changes. Calls that change nothing record nothing.

Postgres migration `0034`, SQLite `0019`. A custom backend must implement `teams` and `teamMemberships` (the conformance suite covers them).
