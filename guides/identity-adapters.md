# Identity adapters

An adapter answers one question: **who is this?** It turns whatever your auth provider gave you (a token, a session) into an
`Identity` (`{ provider, subject }`) and, for invitations, into a **provider-verified e-mail**. It never decides what the person can do:
that is the [engine](concepts.md#the-engine-deny-by-default)'s job.

All four adapters have the same functions (the three below, plus [`toProfile` and `resolveIdentityWithProfile`](#profiles)) and **no dependency on the provider's SDK**: you pass the client or verifier you already configured.

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

## Profiles

To show a person (name, e-mail, avatar) and not just an id, each adapter also has `toProfile(user)` and
`resolveIdentityWithProfile(...)`, which verifies once and returns `{ identity, profile }` (or `null`, same fail-closed contract as
`resolveIdentity`). A profile is **display data only**: it never takes part in a decision, and the avatar is just a URL (an object, a `data:` or a
`javascript:` URL is dropped; fields the user does not have are left out).

| Adapter | Name | E-mail | Avatar |
| --- | --- | --- | --- |
| `@uniora/supabase` | `user_metadata.full_name` / `name` | `email` | `user_metadata.avatar_url` / `picture` |
| `@uniora/clerk` | `name`, or `first_name` + `last_name` (Backend `User`: `firstName` + `lastName`) | `email` (Backend `User`: primary of `emailAddresses`) | `picture` / `image_url` (Backend `User`: `imageUrl`) |
| `@uniora/auth0` | `name`, else `nickname` | `email` | `picture` |
| `@uniora/better-auth` | `name` | `email` | `image` |

Clerk's default session token has **no** profile claims: add `name`, `email` and `picture` to your session token template, or pass the Backend
`User` (`clerkClient.users.getUser(id)`) to `toProfile`. Auth0 access tokens carry them only if you add the claims (an ID token or `/userinfo`
always does).

Store it where you already resolve the caller with `createProfileSync` ([Core reference](core-reference.md#members-with-profiles)): the
first request of every person, new or long-standing, writes their profile, and Studio shows it from then on.

```ts
const syncProfile = createProfileSync(storage);
const session = await resolveIdentityWithProfile(supabase, accessToken);
if (!session) return unauthorized();
await syncProfile(session.identity, session.profile);
```

## Rules worth knowing

- The subject must be the provider's **stable user id** (`sub`, `user.id`), never an e-mail or a username that can change.
- A credential that fails verification yields `null`, never an exception and never a partial identity: treat `null` as "not signed in" (HTTP 401).
- Use `toVerifiedEmail`, not a form field, as `verifiedEmail` when accepting an invitation ([Invitations](invitations.md)).
- Using more than one provider at once is fine: identities from different providers are different identities. To let one person keep their organizations when they move, [link the identities](concepts.md#identity) after verifying both.
- A provider that is not listed: write a ten-line function returning `{ provider: "my-provider", subject }`. Nothing else in UNIORA changes.
