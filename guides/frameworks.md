# Frameworks: Express, Next.js and React

None of these packages depends on its framework, so they work with any version you run. Each is a thin layer over the same
engine: **the server decides**, the UI only reflects.

```text
resolve identity (adapter) ──> engine.can / access.check ──> allow, or 401 / 403
```

## Express: `@uniora/express`

```bash
npm install @uniora/core @uniora/express
```

```ts
import { requirePermission, requireFeature, authorize } from "@uniora/express";

// Whatever your auth middleware stored on the request (via an identity adapter).
const resolve = (req) => req.identity && { identity: req.identity, organizationId: req.params.orgId };

app.delete("/orgs/:orgId/vehicles/:id", requirePermission(engine, "vehicles.delete", { resolve }), deleteVehicle);
app.get("/orgs/:orgId/reports", requireFeature(engine, "advanced_reports", { resolve }), listReports);
app.post("/orgs/:orgId/ai", authorize(engine, { permission: "assistant.use", feature: "ai_assistant", resolve }), askAssistant);
```

| Function | Checks |
| --- | --- |
| `requirePermission(engine, permission, options)` | `engine.can` |
| `requireFeature(engine, feature, options)` | the feature is on **and** the caller is a member (`access.check`) |
| `authorize(engine, { permission?, feature?, resolve, … })` | both; at least one of the two is required (`TypeError` otherwise) |

`permission` and `feature` can be a string or a function of the request (`(req) => string`).

**Options** (`MiddlewareOptions`)

- `resolve(req)` returns `{ identity, organizationId }`, or `null`/`undefined` when nobody is signed in. It may be async.
- `onUnauthenticated(req, res)` replaces the default `401 { "error": "unauthenticated" }`.
- `onDenied(req, res)` replaces the default `403 { "error": "forbidden" }`.

**Fail closed.** A dynamic permission or feature that resolves to `undefined` or `""` is denied. Any exception (yours, the engine's, the database's)
goes to `next(err)`; a failure can never let the request through. The middleware does not rely on Express 5's async error handling, so Express 4 works too.

Take `organizationId` from the route, never from the request body. Invitation routes are in [Invitations](invitations.md#routes).
A complete app: [`examples/express-sqlite`](../examples/express-sqlite).

## Next.js: `@uniora/next`

```bash
npm install @uniora/core @uniora/next
```

Server Action: throw on deny.

```ts
"use server";
import { assertCan, assertAccess, AuthorizationDeniedError } from "@uniora/next";

export async function deleteVehicle(orgId: string, id: string) {
  const identity = await currentIdentity(); // your adapter call; null means signed out
  if (!identity) throw new Error("unauthenticated");
  await assertCan(engine, { identity, organizationId: orgId, permission: "vehicles.delete" }); // throws AuthorizationDeniedError
  // …delete…
}
```

Route Handler: return a `Response` on deny.

```ts
import { authorizeRoute } from "@uniora/next";

export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const identity = await currentIdentity();
  if (!identity) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { orgId } = await params;
  const denied = await authorizeRoute(engine, { identity, organizationId: orgId, permission: "reports.read", feature: "advanced_reports" });
  if (denied) return denied; // 403 { "error": "forbidden" }, or pass { status, body } as a third argument
  return Response.json(await loadReports(orgId));
}
```

| Function | Behaviour |
| --- | --- |
| `assertCan(engine, input)` / `assertAccess(engine, input)` | resolves, or throws `AuthorizationDeniedError` |
| `authorizeRoute(engine, input, { status?, body? }?)` | `null` when allowed, otherwise a ready-to-return JSON `Response` (default `403 { "error": "forbidden" }`) |
| `createCachedIdentity(resolve)` | request-scoped memoization of your identity lookup (`react.cache`) |
| `createCachedAuthorizationSnapshot(engine, storage.features)` | request-scoped memoization of `computeAuthorizationSnapshot` |
| `previewInvitationRoute` / `acceptInvitationRoute` | invitation endpoints, see [Invitations](invitations.md#routes) |

`authorizeRoute` uses `access.check`, so passing only `feature` still requires membership; passing neither only checks membership.

## React: `@uniora/react`

Headless: no styles, no design system. The server computes a snapshot, the client reads it.

```tsx
// Server Component
const snapshot = await createCachedAuthorizationSnapshot(engine, storage.features)({
  identity, organizationId,
  permissions: ["vehicles.create", "vehicles.delete"], // list exactly what this view needs
  features: ["advanced_reports"],
});
return (
  <UnioraProvider snapshot={snapshot}>
    <Vehicles />
  </UnioraProvider>
);
```

```tsx
"use client";
import { Can, Feature, useCan, useFeature } from "@uniora/react";

<Can permission="vehicles.create" fallback={<p>You can't add vehicles.</p>}>
  <CreateVehicleButton />
</Can>
<Feature feature="advanced_reports"><AdvancedReportsPanel /></Feature>

const canDelete = useCan("vehicles.delete"); // boolean
const hasAi = useFeature("ai_assistant");     // boolean
```

- A key that was **not** listed when the snapshot was computed reads as `false`, and in development a console warning tells you which key was missing.
- Outside a `UnioraProvider` everything reads as `false`.
- `<Can>` and `<Feature>` are UX. Hiding a button never replaces the server check on the operation behind it.
- The snapshot is plain JSON (`{ organizationId, permissions, features }`) and safe to send to the browser. It is a snapshot: re-compute it when roles or features change.

[`apps/playground`](../apps/playground) is a runnable Next.js app that switches between an Owner, a salesperson and a viewer and shows `<Can>`, `assertCan` and `authorizeRoute` side by side.
