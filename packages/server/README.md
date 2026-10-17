# @uniora/server

[UNIORA](https://github.com/CodexSploitx/uniora) as its own self-hosted HTTP service. Organizations, roles, permissions, teams, policies and invitations live in a dedicated server with its own database; your backends call it with an API key and your auth provider stays in your project. UNIORA only receives the id of the user your provider gave you.

```bash
npm install @uniora/cli                                   # the easiest way to run it
npx uniora migrate
npx uniora server clients create --name backend --scopes check,organizations:read --orgs '*'
npx uniora server keys create --client backend            # printed once
npx uniora server start --default-provider main
```

```ts
import { createUnioraServer } from "@uniora/server";

const server = createUnioraServer({ storage, credentials, defaultProvider: "main" });
await server.listen({ host: "127.0.0.1", port: 8787 }); // off loopback it needs TLS or a declared TLS proxy
```

- **Authenticated, scoped and bounded**: API keys (SHA-256 at rest, constant-time, never cached), scopes per route, an organization list per client, rate limits, concurrency caps, body and time limits, failed-authentication throttling.
- **Strict in, shaped out**: unknown fields are refused, responses carry only what their schema declares, errors are `application/problem+json` with a stable `code` and never an internal message.
- **Who the people are**: `PUT /v1/profiles` stores the name, e-mail and avatar URL of your users (scope `profiles:write`, a client with every organization; up to 100 per call, all or none) and member reads carry them, so Studio and your screens show a person and not an id. See [Profiles](https://github.com/CodexSploitx/uniora/blob/main/guides/server.md#profiles-show-a-person-not-an-id).
- **Delegated calls**: changes of power run as the end user (`Uniora-Actor-*` headers, `actor:assert` scope), so the anti-escalation rules apply to them; every audit entry says which API client relayed it.
- **Who is calling, and for whom**: API keys, or the access tokens of your own OAuth 2.0 server (`machineTokens`); an end user proven by their own token (`actorTokens`, `Uniora-Actor-Token`: a leaked key cannot impersonate anybody) with the session facts policies need; platform administration under `/v1/platform` with the operator's token and a recent second factor.
- **Events out**: signed, retried webhooks from the outbox, with an SSRF guard and secrets that rotate with a grace period (`uniora webhooks ...`); an optional rate limit shared by all instances.
- **One contract**: the routes, the [OpenAPI document](https://github.com/CodexSploitx/uniora/blob/main/guides/openapi.json), the [reference](https://github.com/CodexSploitx/uniora/blob/main/guides/server-api.md) (every example executed) and the typed `@uniora/client` are generated from the same table.

Guides: [the server](https://github.com/CodexSploitx/uniora/blob/main/guides/server.md) · [API reference](https://github.com/CodexSploitx/uniora/blob/main/guides/server-api.md).

License: [Apache-2.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
