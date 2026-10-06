# @uniora/react

Headless React helpers for [UNIORA](https://github.com/CodexSploitx/uniora): `<Can>`, `<Feature>`, `useCan` and `useFeature` over an `AuthorizationSnapshot` that your **server** computes. The client never talks to your database.

```bash
npm install @uniora/core @uniora/react
```

```ts
// server (Server Component, API route...)
import { computeAuthorizationSnapshot } from "@uniora/core";
const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
  identity, organizationId, permissions: ["vehicles.create"], features: ["advanced_reports"],
});
```

```tsx
// client
import { Can, Feature, UnioraProvider } from "@uniora/react";

<UnioraProvider snapshot={snapshot}>
  <Can permission="vehicles.create"><CreateVehicleButton /></Can>
  <Feature feature="advanced_reports"><ReportsPanel /></Feature>
</UnioraProvider>
```

These components are UX only. Hiding a button is never a substitute for authorizing the real operation on the server.

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
