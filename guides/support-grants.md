# Support access for platform operators (support grants)

Your own staff are not members of your customers' organizations, and they shouldn't be: a permanent membership is a standing
risk. A **support grant** gives one person temporary, narrow, audited access to one organization.

```ts
// The customer's admin asked for help (or your support lead approved it):
const grant = await audited.supportGrants.create({
  id: crypto.randomUUID(),
  organizationId,
  operator: { provider: "staff", subject: "agent-17" },   // who gets access
  grantedBy: adminIdentity,                                // who authorised it
  reason: "Ticket 4821: customer can't see their reports", // required, shown in the audit log
  permissions: ["reports.read", "reports.write"],          // exactly what it allows, plus what those imply
  expiresAt: new Date(Date.now() + 2 * 3600 * 1000),       // at most 30 days away
});

await engine.can({ identity: agent, organizationId, permission: "reports.read" }); // true until it expires
await audited.supportGrants.revoke(grant.id, { by: adminIdentity });               // ends it now
```

## What it is and isn't

- **Narrow**: only the listed keys (1 to 50, all registered) and the permissions they imply. There is no wildcard and no way to grant the Owner role; the Owner-only operations stay with the Owner.
- **Temporary**: it expires by itself and never lasts more than 30 days; renew it on purpose.
- **Audited**: `createAuditedStorage` records `support_grant.created` (operator, grantor, permissions, expiry, reason) and `support_grant.revoked`. With `onDecision` you also see `via: "support_grant"` on each decision a grant allowed.
- **Same rules as everyone**: a suspended or archived organization denies the operator too, and a blocked membership is not bypassed by a grant. `access.check` counts a grant holder as inside the organization.
- **Not for RLS**: the SQL functions (`uniora.has_permission`, …) ignore grants on purpose. Operators work through trusted server code (a service role), not through row policies; if you ever need it in SQL, say so and it will be an explicit, separate function.
- **Who may create one is your call**: UNIORA doesn't know who your platform operators are. Check that in your own code (an admin of the organization, or your support lead) before calling `create`.

Postgres migration `0028`, SQLite `0013`. Use `supportGrants.search({ organizationId, status: "active" })` for an "who has access right now" screen.
