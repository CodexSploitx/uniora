# @uniora/client

The typed client of the [UNIORA](https://github.com/CodexSploitx/uniora) API (`@uniora/server`), for your backend.

```bash
npm install @uniora/client
```

```ts
import { createUnioraClient } from "@uniora/client";

const uniora = createUnioraClient({ baseUrl: process.env.UNIORA_URL!, apiKey: process.env.UNIORA_API_KEY! });

const { allowed } = await uniora.decisions.check({ identity: { subject: user.id }, organizationId, permission: "vehicles.delete" });

// A change on behalf of the signed-in user: the server applies the anti-escalation rules to THEM.
await uniora.members.assignRole({ organizationId, membershipId, roleId }, { actor: { subject: session.userId } });
```

- Every operation is a typed method, generated from the server's route table.
- Retries with backoff only where they cannot repeat a change; an `Idempotency-Key` is added for the calls that create something.
- Refuses to run in a browser, to send the key over plain `http:` (except to this machine) and to print the key.
- `createRemoteEngine(uniora)` is an `AuthorizationEngine` that asks the server, so the Express and Next guards work unchanged. It fails closed.

Guide: [the server](https://github.com/CodexSploitx/uniora/blob/main/guides/server.md) · [API reference](https://github.com/CodexSploitx/uniora/blob/main/guides/server-api.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
