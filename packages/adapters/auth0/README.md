# @uniora/auth0

Auth0 identity adapter for [UNIORA](https://github.com/CodexSploitx/uniora). It only answers "who is this?": it returns an `Identity` (`{ provider, subject }`), or `null` for anything it can't verify, and never throws into an access decision. What that identity may do is always decided by the `AuthorizationEngine` in `@uniora/core`.

```bash
npm install @uniora/core @uniora/auth0
```

```ts
import { resolveIdentity, toVerifiedEmail } from "@uniora/auth0";

const identity = await resolveIdentity(verifyAccessToken, accessToken); // Identity | null
```

`toVerifiedEmail` returns the address the provider has **verified**, or `null`. Pass it as `verifiedEmail` to `invitations.accept(...)` (never an address the user merely typed). 

The adapter defines a minimal structural contract for your already-configured client, so it adds no dependency on the provider's SDK.

Documentation: [Identity adapters guide](https://github.com/CodexSploitx/uniora/blob/main/guides/identity-adapters.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
