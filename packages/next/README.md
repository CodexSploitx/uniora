# @uniora/next

Next.js glue for [UNIORA](https://github.com/CodexSploitx/uniora): request-scoped memoization with `react.cache()` and authorization guards for Server Actions and Route Handlers. No dependency on the `next` package; only the standard `Request`/`Response` APIs.

```bash
npm install @uniora/core @uniora/next
```

```ts
import { assertCan, authorizeRoute } from "@uniora/next";

// Server Action: throws AuthorizationDeniedError when denied.
await assertCan(engine, { identity, organizationId, permission: "vehicles.delete" });

// Route Handler: returns a ready-to-return Response, or null when allowed.
const denied = await authorizeRoute(engine, { identity, organizationId, permission: "vehicles.delete" });
if (denied) return denied;
```

## Invitation route handlers

```ts
// app/api/invite/[token]/route.ts
import { previewInvitationRoute } from "@uniora/next";
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  return previewInvitationRoute(invitations, (await params).token);
}

// app/api/invite/[token]/accept/route.ts
import { acceptInvitationRoute } from "@uniora/next";
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = await getVerifiedUser(); // your auth provider; use its adapter's toVerifiedEmail
  return acceptInvitationRoute(invitations, {
    token: (await params).token,
    caller: user && { identity: user.identity, verifiedEmail: user.verifiedEmail },
  });
}
```

Failures follow `invitationErrorToHttp` from `@uniora/core`: one generic `400 invalid_invitation` for every way an accept can fail.

Documentation: [Express, Next.js and React guide](https://github.com/CodexSploitx/uniora/blob/main/guides/frameworks.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
