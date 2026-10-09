# Audit log

Every change made through the audited storage leaves an entry saying **who** did **what** to **which** target, written in the same
transaction as the change. The log is append-only and hash-chained, so editing or deleting an entry is detectable.

## Record changes automatically

```ts
import { createAuditedStorage } from "@uniora/core";

// once per request or job: the actor is whoever is acting
const audited = createAuditedStorage(storage, { actor: identity });
await audited.memberships.block(membershipId, { actor: identity, reason: "unpaid" }); // writes "membership.blocked"
```

`createAuditedStorage(storage, { actor, outbox? })` wraps organizations, memberships, roles, permissions, features, entitlements and support grants.
A test fails if a repository gains a mutating method that is not audited. Invitations and identity links write their own entries. Pass `outbox: true` to
also enqueue one [outbox event](outbox.md) per audited change.

Standard action names are in `AUDIT_ACTIONS` (`isStandardAuditAction(name)` tells whether a string is one):

| Area | Actions |
| --- | --- |
| Organization | `organization.created`, `.renamed`, `.updated`, `.status_changed`, `.ownership_transferred` |
| Membership | `membership.created`, `.deleted`, `.left`, `.blocked`, `.suspended`, `.unblocked`, `.role_assigned`, `.role_unassigned`, `.owner_role_assigned`, `.owner_role_unassigned` |
| Role | `role.created`, `.owner_created`, `.renamed`, `.updated`, `.cloned`, `.permissions_replaced`, `.deleted`, `.permission_granted`, `.permission_revoked` |
| Permission | `permission.registered`, `.unregistered` |
| Feature | `feature.registered`, `.unregistered`, `.enabled`, `.disabled`, `.bulk_changed`, `.disabled_everywhere` |
| Entitlement | `entitlement.defined`, `.removed`, `.limit_changed`, `.limit_cleared` (consuming is not audited) |
| Support grant | `support_grant.created`, `.revoked` |
| Team | `team.created`, `.updated`, `.archived`, `.restored`, `.deleted`, `.owner_changed`, `.manager_changed` |
| Team membership | `team_member.added`, `.invited`, `.accepted`, `.reactivated`, `.suspended`, `.removed`, `.role_assigned`, `.role_unassigned` |
| Invitation | `invitation.created`, `.resent`, `.revoked`, `.accepted`, `.delivery_failed` |
| Identity link | `identity_link.created`, `.removed` |
| Access | `access.change_refused` (a role change stopped by the anti-escalation rules; see [Access administration](./access-admin.md)) |
| Audit | `audit_log.pruned` |

## Write your own entries

```ts
await storage.auditLogs.record({
  id: crypto.randomUUID(),
  organizationId,                       // optional: omit for global events
  actor: identity,                      // required
  action: "report.exported",            // required, up to 200 characters; your own names are fine
  target: { type: "report", id: reportId },
  metadata: { format: "csv" },          // no secrets
});
```

An entry without an actor (`audit_actor_required`) or without an action (`audit_action_invalid`) is rejected in every backend.

## Read

```ts
const page = await storage.auditLogs.search({
  organizationId,
  actionPrefix: "membership.",          // or action: "role.deleted" / ["a", "b"]
  actor: identity,
  target: { type: "membership", id },
  since: new Date("2026-01-01"),
  until: new Date(),
  limit: 50,
  before: lastEntry && { createdAt: lastEntry.createdAt, id: lastEntry.id }, // keyset cursor from the last row of the previous page
}); // newest first
```

`listByOrganization(organizationId, { limit?, before? })` and `listRecent({ limit?, before? })` are the simple forms. An entry is
`{ id, organizationId?, actor, action, target?, metadata?, createdAt }`.

## Verify

```ts
const report = await storage.auditLogs.verifyIntegrity();
// { ok, checked, head?: { position, hash }, anchor?, pruned?, broken?: { id, reason } }
```

`ok: false` names the first entry that doesn't match (`content_mismatch` or `chain_broken`). It is linear in the log size: run it from a scheduled job (and
`npx uniora doctor` runs it for you), never per request.

A chain alone can't reveal that the **newest** entries were deleted. Store the head somewhere the database admin can't rewrite (a write-once bucket, another system) and check it later:

```ts
const { head } = await storage.auditLogs.verifyIntegrity();   // save this externally
// later:
const check = await storage.auditLogs.verifyIntegrity({ anchor: head });
check.anchor; // "valid" | "missing" (truncated) | "mismatch" (history changed) | "pruned" (anchor older than a retention checkpoint)
```

## Retention

```ts
import { applyAuditRetention } from "@uniora/core";

const result = await applyAuditRetention(storage, { keep: { years: 5 }, actor: jobIdentity }); // minimum 30 days
// { removed, through?: { position, hash }, before }
```

It removes entries older than the cut-off (never the newest one), writes a checkpoint so the chain keeps verifying, and records `audit_log.pruned`. Export what
you must keep with `search` **before** it runs, and re-take your external anchor afterwards. In PostgreSQL the pruning function is revoked from `public`: grant it only to
the retention job's role ([Hardening §4](hardening.md)). The lower level is `auditLogs.pruneBefore({ before, actor })`.

## Decisions are not audited by default

The engine never writes audit entries. To keep a trail of allow and deny decisions, pass `onDecision` to `createAuthorizationEngine` and store them wherever suits your volume.
