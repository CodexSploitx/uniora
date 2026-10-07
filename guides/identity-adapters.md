# Identity adapters

An adapter answers one question: **who is this?** It turns whatever your auth provider gave you (a token, a session) into an
`Identity` (`{ provider, subject }`) and, for invitations, into a **provider-verified e-mail**. It never decides what the person can do:
that is the [engine](concepts.md#the-engine-deny-by-default)'s job.

All four adapters have the same three functions and **no dependency on the provider's SDK**: you pass the client or verifier you already configured.

| Function | Returns | Purpose |
| --- | --- | --- |
| `resolveIdentity(client, credential)` | `Promise<Identity \| null>` | Verifies the credential; `null` for anything invalid. Never throws. |
| `toIdentity(user)` | `Identity` | Build the identity from an already-verified user/payload. Throws `TypeError` without a stable subject. |
| `toVerifiedEmail(user)` | `string \| null` | The e-mail only when the provider says it is verified, trimmed. `null` otherwise. |

## Supabase: `@uniora/supabase`

```ts
import { createClient } from "@supabase/supabase-js";
import { resolveIdentity, toVerifiedEmail } from "@uniora/supabase";

const supabase = createClient(url, serviceOrAnonKey);
const identity = await resolveIdentity(supabase, accessToken); // calls supabase.auth.getUser(token). provider: "supabase"

const { data } = await supabase.auth.getUser(accessToken);
const verifiedEmail = toVerifiedEmail(data.user);              // needs email_confirmed_at (or confirmed_at)
```

## Clerk: `@uniora/clerk`

`resolveIdentity` takes a function `(token) => Promise<{ data } | { errors }>`, the shape of Clerk's `verifyToken`:

```ts
import { verifyToken } from "@clerk/backend";
import { resolveIdentity, toIdentity, toVerifiedEmail } from "@uniora/clerk";

const identity = await resolveIdentity((token) => verifyToken(token, { secretKey }), sessionToken); // provider: "clerk", subject: payload.sub
```

`toVerifiedEmail(payload)` needs `email` and `email_verified === true` in the payload (add them to your Clerk session token template).

## Auth0: `@uniora/auth0`

`resolveIdentity` takes a function that verifies the access token and returns its payload (throwing on a bad token):

```ts
import { resolveIdentity } from "@uniora/auth0";

const identity = await resolveIdentity(async (token) => (await verifyJwt(token, { issuer, audience })), accessToken); // provider: "auth0"
```

`toVerifiedEmail` needs `email` and `email_verified === true` in the payload.

## Better Auth: `@uniora/better-auth`

`resolveIdentity` takes a `getSession(headers)` function and the request headers (anything with `get(name)`):

```ts
import { auth } from "./auth";            // your betterAuth() instance
import { resolveIdentity } from "@uniora/better-auth";

const identity = await resolveIdentity((headers) => auth.api.getSession({ headers }), request.headers); // provider: "better-auth"
```

`toVerifiedEmail(user)` needs `user.emailVerified === true`.

## Rules worth knowing

- The subject must be the provider's **stable user id** (`sub`, `user.id`), never an e-mail or a username that can change.
- A credential that fails verification yields `null`, never an exception and never a partial identity: treat `null` as "not signed in" (HTTP 401).
- Use `toVerifiedEmail`, not a form field, as `verifiedEmail` when accepting an invitation ([Invitations](invitations.md)).
- Using more than one provider at once is fine: identities from different providers are different identities. To let one person keep their organizations when they move, [link the identities](concepts.md#identity) after verifying both.
- A provider that is not listed: write a ten-line function returning `{ provider: "my-provider", subject }`. Nothing else in UNIORA changes.
