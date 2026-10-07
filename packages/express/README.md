# @uniora/express

Express middleware and invitation routes for [UNIORA](https://github.com/CodexSploitx/uniora). It has no dependency on the `express` package, so it suits Express 4 and 5 and answers `401`/`403` itself; any error goes to `next(err)`, so a failure can never let a request through.

```bash
npm install @uniora/core @uniora/express
```

## Guard a route

```ts
import { requirePermission, requireFeature } from "@uniora/express";

app.delete(
  "/orgs/:orgId/vehicles/:id",
  requirePermission(engine, "vehicles.delete", {
    resolve: (req) => req.identity && { identity: req.identity, organizationId: req.params.orgId },
  }),
  deleteVehicle,
);
```

`requireFeature(engine, "ai_assistant", { resolve })` checks what the organization has unlocked; `authorize(engine, { permission, feature, resolve })` checks both. A permission that resolves to `undefined` or `""` at request time is **denied**.

## Invitation routes

```ts
import { acceptInvitation, invitationPreview, requirePermission } from "@uniora/express";

// You decide who may invite: put your guard in front of `invitations.invite(...)`.
app.post("/orgs/:orgId/invitations", requirePermission(engine, "members.invite", { resolve }), inviteHandler);

app.get("/invite/:token", invitationPreview(invitations, { token: (req) => req.params.token }));
app.post(
  "/invite/:token/accept",
  acceptInvitation(invitations, {
    token: (req) => req.params.token,
    // The signed-in caller and the e-mail your auth provider VERIFIED (an adapter's toVerifiedEmail).
    resolve: async (req) => req.user && { identity: req.identity, verifiedEmail: req.user.verifiedEmail },
  }),
);
```

Every way an accept can fail (unknown, expired, revoked, used, wrong e-mail) answers the same `400 { error: "invalid_invitation" }`, so the route can't be used to probe which links or addresses exist. See [`examples/express-sqlite`](https://github.com/CodexSploitx/uniora/tree/main/examples/express-sqlite) for a complete app.

Documentation: [Express, Next.js and React guide](https://github.com/CodexSploitx/uniora/blob/main/guides/frameworks.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
