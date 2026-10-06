# Events after commit (outbox)

When something changes in UNIORA you often need to tell another system: invalidate a cache, call a webhook, send an e-mail,
publish to a queue. Doing it inside the request is fragile: if the change rolls back the message already left, and if the
process dies right after the commit the message never leaves. The **outbox** fixes both: the event is written in the SAME
transaction as the change, and a worker delivers it afterwards.

```ts
import { createAuditedStorage, dispatchOutbox } from "@uniora/core";

// 1. Every audited change also enqueues an event (type = the audit action: member.blocked, role.updated, …).
const storage = createAuditedStorage(raw, { actor, outbox: true });
await storage.memberships.block(id, { actor, reason: "unpaid" });

// 2. Your own events, atomic with your own writes:
await raw.transaction(async (tx) => {
  await tx.memberships.assignRole(membershipId, roleId);
  await tx.outbox.enqueue({ id: `plan-changed:${membershipId}:${version}`, type: "plan.changed", organizationId, payload: { membershipId } });
});

// 3. A worker (cron, interval, serverless schedule) delivers them:
await dispatchOutbox(raw.outbox, async (event) => {
  await fetch(webhookUrl, { method: "POST", headers: { "Idempotency-Key": event.id }, body: JSON.stringify(event) });
});
```

## What you get

- **Atomic**: a rolled-back change leaves no event; a committed one can't lose it.
- **At least once**: a crash after delivering, or a lease that expired, delivers an event again. Make the handler idempotent by `event.id`.
- **Retries with backoff**: a handler that throws is retried after 30 s, 60 s, 120 s … (capped at 1 h); after `maxAttempts` (8) the event is parked as `dead` with the last error (secrets you pass in `secrets` are scrubbed). `outbox.requeue(id)` puts it back.
- **Several workers at once**: claims use a lease (`for update skip locked` in Postgres, one `begin immediate` in SQLite), so two workers never receive the same event while its lease holds. Pick `leaseSeconds` longer than your slowest handler.
- **Order**: events are handed out oldest first (`seq`). With several workers, or transactions that commit out of order, strict order across events is NOT guaranteed; if you need "apply in order", carry a version in the payload.
- **Housekeeping**: `outbox.pruneDelivered(before)` deletes delivered events (run it daily); `outbox.search({ status: "dead" })` and `count` feed an operator screen.

## What is and isn't emitted

`createAuditedStorage(…, { outbox: true })` emits for organizations, memberships, roles, permissions and features, with the
actor, the target and the audit metadata (no secrets; an oversized change keeps the facts and omits the detail). Invitations
and identity links write their own audit entries and are not emitted yet; enqueue your own event around them if you need one.

Postgres migration `0026`, SQLite `0011`. The least-privilege role of `guides/sql/least-privilege-roles.sql` already covers the table.
