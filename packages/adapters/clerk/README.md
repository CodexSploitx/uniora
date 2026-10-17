# @uniora/clerk

Clerk identity adapter for [UNIORA](https://github.com/CodexSploitx/uniora). It only answers "who is this?": it returns an `Identity` (`{ provider, subject }`), or `null` for anything it can't verify, and never throws into an access decision. What that identity may do is always decided by the `AuthorizationEngine` in `@uniora/core`.

```bash
npm install @uniora/core @uniora/clerk
```

```ts
import { resolveIdentity, toVerifiedEmail } from "@uniora/clerk";

const identity = await resolveIdentity(verifyToken, sessionToken); // Identity | null, verifyToken from @clerk/backend
```

`toVerifiedEmail` returns the address the provider has **verified**, or `null`. Pass it as `verifiedEmail` to `invitations.accept(...)` (never an address the user merely typed). 

`toProfile(user)` returns `{ displayName, email, avatarUrl }` (display data only, the avatar is just a URL) and `resolveIdentityWithProfile(...)` verifies once and returns `{ identity, profile }`: pass them to `createProfileSync(storage)` from `@uniora/core` so Studio shows the person, not an id. See [Identity adapters](https://github.com/CodexSploitx/uniora/blob/main/guides/identity-adapters.md#profiles).

The adapter defines a minimal structural contract for your already-configured client, so it adds no dependency on the provider's SDK.

Documentation: [Identity adapters guide](https://github.com/CodexSploitx/uniora/blob/main/guides/identity-adapters.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [Apache-2.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
