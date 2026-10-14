# The UNIORA server: authorization as a service you run

`@uniora/core` is a library you import. `@uniora/server` is the same engine behind an HTTP API, for the teams that do **not** want
it inside their application code: organizations, roles, permissions, teams, policies and invitations live in a dedicated service
with its own database, and your backends talk to it with an API key. Your auth provider (Supabase Auth, Clerk, Auth0, Better
Auth...) stays where it is, in your project. UNIORA never sees a password or a session: it only receives the id of the user that
your provider gave you.

```
 browser ──► your backend ──────────────► UNIORA server ──► its own database
              │  (verifies the session     (API key, scopes,    (Postgres or SQLite)
              │   with your auth provider)  organization list)
              └── asks: "may user 3f2c… delete vehicles in org_acme?"
```

Each customer runs their own server and their own database. There is no shared UNIORA cloud.

| | |
| --- | --- |
| **The call, endpoint by endpoint** | [API reference](server-api.md) (every example in it was executed), and the machine-readable [`openapi.json`](openapi.json) |
| **From TypeScript** | `@uniora/client`: typed calls, retries, and a remote engine for the Express and Next guards ([below](#from-your-backend-uniora-client)) |
| **Who may call** | API clients and keys, managed in Studio or with `uniora server …` ([below](#api-clients-and-keys)); or your own OAuth server ([machine tokens](#machine-tokens-your-own-oauth-server-instead-of-keys)) |
| **Everything else the server can do** | [verified end users](#verified-end-users-the-list-of-providers), [platform administration](#platform-administration), [webhooks](#webhooks), [a shared rate limit](#a-rate-limit-shared-between-instances), and [the `server` section of `uniora.config.mjs`](#configuring-the-server-from-the-config-file) |

## Quick start

You need a database (SQLite is enough to try it) and the packages:

```bash
npm install @uniora/cli @uniora/client
```

1. **Configure and migrate** (once). `uniora.config.mjs` is the same file the rest of UNIORA uses ([CLI and Studio](cli-and-studio.md)):

   ```bash
   npx uniora init --provider sqlite
   npx uniora migrate
   ```

2. **Create an API client and a key.** A client is one of your backends; it has scopes and a list of organizations:

   ```bash
   npx uniora server clients create --name backend --scopes check,organizations:read --orgs '*'
   npx uniora server keys create --client backend
   # ✓ Clave: creada para "backend" (…). Cópiala ahora: no se volverá a mostrar.
   # uniora_sk_…
   ```

   The key is printed **once**. UNIORA keeps only a fingerprint of it, so a lost key is replaced, never recovered.

3. **Start the server:**

   ```bash
   npx uniora server start --default-provider main
   # ✓ Servidor: escuchando en http://127.0.0.1:8787
   ```

4. **Ask it something:**

   ```bash
   curl -X POST http://127.0.0.1:8787/v1/check \
     -H "Authorization: Bearer $UNIORA_API_KEY" -H "Content-Type: application/json" \
     -d '{"identity":{"subject":"3f2c9a10-8b1e-4c2d-9f7a-1e2b3c4d5e6f"},"organizationId":"org_acme","permission":"vehicles.delete"}'
   # {"allowed":false}
   ```

   `false` is also what you get for an organization that does not exist, a user who is not a member and a malformed permission
   key: the engine denies by default and never says why.

## Who the user is

Every call about a person sends `{ "provider"?: "…", "subject": "…" }`:

- **`subject`** is the user's stable id in your auth provider (the Supabase `user.id`, the Clerk `userId`, the Auth0 `sub`). Never an
  e-mail address: addresses change.
- **`provider`** is an **opaque label you choose**. It keeps the ids of two auth systems from colliding and lets you migrate from
  one provider to another later. It does **not** have to name your vendor (`"main"` is fine) and it reveals nothing about your stack.
  Start the server with a default (`--default-provider main`) and your requests can leave it out. **Never change the default once
  data exists**: it is part of every stored identity.
- With no default and no `provider` in the request, the call is refused (`400 identity_provider_required`). The server never guesses.
- `uniora-api`, `uniora-studio`, `uniora-cli` and `uniora-platform` are reserved for UNIORA's own principals in the audit log; a
  user can never be one of them.

## API clients and keys

A **client** is a backend of yours. It has:

- **scopes**: which families of calls it may make (`check`, `organizations:read`, `members:write`...; the list is in the
  [reference](server-api.md#scopes)). Ask for the fewest. The `…:write` scopes act on behalf of an end user and need `actor:assert`.
- **an organization list**: `*` for every organization, or the ids it may touch. A call about any other organization answers
  exactly like one that does not exist.
- up to **two active keys**, so a key can be rotated with no downtime.

A key can never do more than its client. Clients and keys are managed **only** in Studio (**API clients**) and with the CLI: there is
no API route that creates or changes either, because a key that could mint keys would be a privilege-escalation path. Every change is
audited with the operator who made it.

```bash
uniora server clients create --name signup-worker --scopes organizations:create --orgs '*'
uniora server clients create --name profile-sync --scopes profiles:write --orgs '*'   # stores the name, e-mail and avatar of your users
uniora server clients list
uniora server clients update backend --scopes check,organizations:read,members:write,actor:assert
uniora server clients disable backend            # every key of the client stops on its next request
uniora server keys create --client backend --expires-in-days 90
uniora server keys revoke <keyId>                 # takes effect on the next request
```

**Rotating a key** with no downtime: create the new key (a client can hold two), deploy it, check that the old one stops being used
(`last used` in Studio), revoke the old one.

**What the server does with a key**: it parses `uniora_sk_<id>_<secret>_<checksum>`, looks the id up, compares the SHA-256 of the secret
in constant time (an unknown id costs the same as a wrong secret) and checks that the key and its client are active. Nothing is
cached: a revocation applies to the very next request. Every kind of failure (no key, malformed, wrong, revoked, expired, client
disabled) answers the same `401`. After 20 failed attempts a minute from one source address, that address is refused with `429`.

## Running the server

```bash
npx uniora server start [--host H] [--port N] [--default-provider LABEL]
                        [--tls-key FILE --tls-cert FILE | --behind-tls-proxy --trusted-proxy-hops N]
                        [--read-only]
```

It fails closed. It will **not** start when:

- the database has pending or modified migrations (`uniora migrate` first);
- it would listen on anything but this machine without TLS: pass `--tls-key/--tls-cert`, or `--behind-tls-proxy` together with
  `--trusted-proxy-hops N` when a reverse proxy ends TLS. With a proxy, every request except the health checks must carry
  `X-Forwarded-Proto: https`, or it is refused (an API key must never travel in the clear). The caller's address, which the failed
  authentication throttle uses, is the `N`-th entry from the right of `X-Forwarded-For`: say how many proxies you really run;
- an option is invalid (`--default-provider uniora-api`, a limit outside its range...).

**`trustedProxyHops` on its own trusts `X-Forwarded-For` from ANY direct connection, not only from your real proxy.** A rule that
reads "the caller's address is the `N`-th entry from `X-Forwarded-For`" only holds if every request that reaches the process
really went through that proxy. If it can ever be reached directly instead — a misconfigured network ACL, a second listener on
the same host, a load balancer health-check path that skips the proxy, or simply the proxy being down while the port stays open
— an attacker who connects directly can write whatever they like into `X-Forwarded-For`, including a brand-new fake address on
every request. That defeats the failed-authentication throttle completely: each attempt looks like it came from a source never
seen before, so it is never refused. Pass `trustedProxies` (the config file, not a CLI flag — it is a list, like `actorTokens`)
with the exact address(es) of the real proxy to close this:

```ts
trustedProxyHops: 1,
trustedProxies: ["10.0.4.7"], // only this address may set X-Forwarded-For; anyone else gets their own socket address instead
```

With it, a direct connection from any address other than the ones listed is treated exactly as `trustedProxyHops: 0` for that one
request: its own socket address, `X-Forwarded-For` ignored. Left unset (for backward compatibility with an existing deployment),
the server logs one `warn` at start reminding you to set it. There is no CLI flag for `trusted-proxy-hops` without also
considering this: if you deploy from `uniora.config.mjs`, set both together.

From code (for a custom setup, a framework or two database users):

```ts
import { createUnioraServer } from "@uniora/server";
import { createPostgresApiCredentialStorage, createPostgresStorage } from "@uniora/postgres";

const server = createUnioraServer({
  storage: createPostgresStorage(appPool),                       // organizations: the role of the server
  credentials: createPostgresApiCredentialStorage(readOnlyPool), // keys: it only READS them
  defaultProvider: "main",
  trustedProxyHops: 1,
  trustedProxies: ["10.0.4.7"], // the real proxy's address; without it, any direct caller's X-Forwarded-For is trusted
  invitations: { acceptUrl: (token) => `https://app.example.com/invite/${token}`, sender },
});
const running = await server.listen({ host: "0.0.0.0", port: 8787, behindTlsProxy: true });
process.on("SIGTERM", () => running.close()); // lets requests in flight finish, then closes
```

`server.handler` is a plain Node request listener if you would rather mount it yourself.

### Health, logs and read-only

- `GET /healthz` is liveness (always `200 {"status":"ok"}`). `GET /readyz` asks the database and answers `200` or
  `503 {"status":"unavailable"}` with no detail. Neither needs a key.
- Logs are one JSON object per line on stderr: a line per request (`requestId`, route, status, duration, client id, key id, source address)
  and the failures. A key, an `Authorization` header or an actor header is never logged, even if something put one in. The detail of an
  error that was answered as a bare `500` is here, under the `requestId` the caller received.
- `--read-only` answers every change with `503 read_only` while decisions and reads keep working: for a migration or an incident.

### Limits

Everything is bounded before any database work, and every number is configurable (`createUnioraServer({ limits })`):

| Limit | Default |
| --- | --- |
| Request body | 64 KB |
| Page size | 25, at most 100 |
| Checks in one `check:batch` | 50 |
| A request that takes longer is answered `503 timeout` | 5 s |
| Rate per API key (token bucket) | 50 requests/s, burst 100 → `429` with `Retry-After` |
| Requests in flight per key / in the whole process | 20 / 1000 → `429` / `503` |
| Failed authentications per source address | 20 per minute |
| Slow clients | headers 10 s, body 10 s, keep-alive 5 s |

The rate limiter is **per process** unless you turn on the [shared one](#a-rate-limit-shared-between-instances). A request that timed out
keeps its concurrency slot until the work really ends, and if it fails after the `503 timeout` was sent, the failure is still logged.

### Database users

The server only needs to **read** keys and clients (and refresh `last_used_at`). With Postgres, give it a database role that cannot
change them, and keep a different one for Studio and the CLI: [`least-privilege-roles.sql`](sql/least-privilege-roles.sql) has
`uniora_api_server` and `uniora_api_admin`. `uniora server start` uses the one connection of `uniora.config.mjs` for both; use
`createUnioraServer` with two pools (above) to separate them.

## The flows

The [reference](server-api.md) has each call with its fields, errors and a worked example. These are the stories.

### Sign-up: an organization with its first Owner

When someone signs up in your product, your backend creates the organization and makes them its Owner in one call:

```ts
const { organization, membership } = await uniora.organizations.create(
  { name: "Acme Motors", owner: { subject: session.userId } },
  { idempotencyKey: `signup:${session.userId}` },
);
```

The organization, its protected Owner role and the founder's membership are created together or not at all. With an
`Idempotency-Key` a retry (a timeout, a double click, two requests at once) cannot create a second organization: it answers the first
result with `replayed: true`. The client adds a key by itself if you do not pass one and retries are on. Use a client with only
`organizations:create`, and the list `*` (it cannot be limited to organizations that do not exist yet).

### Profiles: show a person, not an id

UNIORA only knows `(provider, subject)`. To let Studio and your own screens show a **name, an e-mail and an avatar**, your backend stores them
where it already knows the user (right after verifying their session), or in pages to backfill the users you already have:

```ts
await uniora.profiles.put({
  profiles: [{ identity: { subject: session.userId }, displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://cdn.example.com/ana.png" }],
});
// at sign-up, in the same call and the same transaction: organizations.create({ name, owner, ownerProfile: { displayName, email } })
```

Up to 100 people per call, stored together or not at all. A field you leave out is **kept**, `null` clears it, and the avatar is just an `http(s)`
URL (an object or any other kind of address is refused with a 400). It is display data only: no authorization decision reads it, and writing
it is not audited (it can run on every sign-in). A person has **one** profile in every organization, so the client needs the `profiles:write`
scope **and** the list `*` (`ownerProfile` at sign-up also needs that scope: a client with only `organizations:create` that sends one is refused).
Member reads (`members.list`, `members.get`) then carry a `profile`, and `q` on the member list also finds a person by the name or e-mail of it.

Your auth adapter already turns its user into this shape (`toProfile`, see [Identity adapters](identity-adapters.md#profiles)); send that.

### Checks and snapshots from your backend

```ts
// May this user do this? false for anything the engine cannot justify.
const { allowed } = await uniora.decisions.check({ identity: { subject: userId }, organizationId, permission: "vehicles.delete" });

// With the organization's policies applied, and what YOUR server knows about the request.
const decision = await uniora.decisions.authorize({
  identity: { subject: userId },
  organizationId,
  permission: "vehicles.delete",
  resource: { type: "vehicle", id: vehicle.id, organizationId: vehicle.organizationId, attributes: { status: vehicle.status } },
  context: { ipCountry: "ES" },                       // signals YOUR server verified
  session: { authenticatedAt: lastSignIn, mfa: true }, // from your auth provider's verified session
});
if (!decision.allowed) return decision.stepUp ? askToReauthenticate() : forbidden();

// What a screen needs, in one call. A key you did not ask for is absent: treat absent as denied.
const { permissions, features } = await uniora.decisions.snapshot({ identity: { subject: userId }, organizationId, permissions: ["vehicles.delete", "vehicles.create"], features: ["advanced_reports"] });
```

`context` and `session` are things only **your** server can know. UNIORA cannot verify them, so never copy them from what the end user
sent: build them from your verified session. See [policies](policies.md) for what they are for.

### Why a feature is off for an organization

`uniora.organizations.features(...)` (`GET /v1/organizations/:organizationId/features`) returns each feature as a check sees it. For an
organization without an override whose feature was switched off for everyone (the kill switch), the item carries the operator's reason:

```ts
const { items } = await uniora.organizations.features({ organizationId });
for (const feature of items) {
  if (!feature.enabled && feature.reason === "default") {
    // `defaultReason` / `defaultUpdatedAt` are optional: absent means no reason was given.
    showUnavailable(feature.defaultReason ?? "This feature is not available.");
  }
}
```

The catalog (`GET /v1/features`) also lists `reason` and `updatedAt` on each killed feature. All of these fields are optional, so a client
from before they existed keeps working. Needs the `organizations:read` scope, as before. The server stores the reason when an operator
pulls the kill switch from the library (`storage.features.disableEverywhere(key, { reason })`).

### Changes on behalf of an end user

Changing who holds which power is a **delegated** call: the services apply the [anti-escalation rules](access-admin.md) **to the end user**
the call speaks for: they can only give what they hold, never to themselves, never touch someone who holds more power than they do. A key
cannot do more than the user it speaks for. There are two ways to say who that is:

| | Verified (recommended) | Asserted |
| --- | --- | --- |
| What travels | the user's own token from your identity provider, in `Uniora-Actor-Token` | the user's id, in `Uniora-Actor-Subject` |
| Who vouches | the server verifies the token against the provider you configured | whoever holds the API key |
| Client scope | `actor:verified` | `actor:assert` (sensitive) |
| A leaked API key can | speak only for users who hold a token right now | speak for **any** user of its organizations |

```ts
// Verified: the signed-in user's own token, as your auth provider issued it.
await uniora.members.assignRole({ organizationId, membershipId, roleId }, { actor: { token: session.accessToken } });
// Asserted: your server says who it is.
await uniora.members.assignRole({ organizationId, membershipId, roleId }, { actor: { subject: session.userId } });
```

Every audit entry keeps the end user as its `actor` and adds `metadata.via = { apiClientId, keyId, requestId, actorMode }`, set by the server
inside the hash chain (`actorMode` is `verified` or `asserted`): you can always tell which backend relayed a change, which request it was and
how the user was identified.

### Verified end users: the list of providers

Tell the server which identity providers it may believe. Each entry says exactly how that provider's tokens are checked; nothing in a token
chooses how it is verified.

```ts
createUnioraServer({
  …,
  defaultProvider: "main",
  actorTokens: [
    {
      provider: "main",                                   // the label stored in these users' identities
      issuer: "https://idp.example.com/",                 // the exact `iss` of the tokens
      audience: "uniora",                                 // what the token's `aud` must name: required, there is no way to switch it off
      algorithms: ["RS256"],                              // pinned: the algorithms this provider signs with
      jwksUri: "https://idp.example.com/.well-known/jwks.json",   // or `jwks: { keys: [...] }`, or `secret` for HS*
      // Optional: subjectClaim ("sub"), maxLifetimeSeconds (86400), clockToleranceSeconds (30), jwksCacheSeconds (600),
      // acrLevels: { "urn:mace:incommon:iap:silver": 2 }
    },
  ],
  requireVerifiedActors: true, // optional: refuse asserted actors altogether, so a leaked key cannot impersonate anybody
});
```

What the server does with `Uniora-Actor-Token`:

- Finds the provider by the token's exact `iss`; the algorithm must be one that provider **pinned** (`none`, a `HS*` token for an `RS*` provider,
  an algorithm you did not list: refused). A symmetric algorithm is only ever checked against a configured `secret` (at least 32 bytes), never
  against a public key, which closes the classic algorithm-confusion attack.
- Takes the key **only** from the provider's configuration: `jwksUri` (HTTPS only, no redirects, 3 s timeout, at most 256 KB and 50 keys, cached, refreshed
  when a `kid` is unknown but never more than once every 30 s, so a stream of made-up key ids cannot make the server hammer your provider; the keys
  it holds are used for up to an hour while the provider is down) or the keys you wrote down. `jku`, `jwk`, `x5u` and `crit` in the token are never used
  (`crit` is refused). RSA keys under 2048 bits and private keys in a key set are refused at start-up. ECDSA must use the raw `r||s` form of JWS.
- Requires `exp`, and checks `nbf`, `iat` (not in the future), the audience, and that the token does not live longer than `maxLifetimeSeconds`.
- Takes the subject from `sub` (or your `subjectClaim`), 1 to 500 characters without control characters. The identity is `{ provider, subject }`
  with the provider's label: make sure it is the label your users are stored under (normally your `defaultProvider`).
- Answers every refusal the same way, `401 actor_token_invalid` (the reason, never the token, is in the server's log), and `503 actor_token_unavailable`
  when the provider's keys cannot be fetched and no recent copy exists.

A few starting points (check your provider's own documentation for the exact issuer, audience and algorithm):

| Provider | Typical shape |
| --- | --- |
| Auth0 | `issuer` is `https://<tenant>/`, `audience` your API identifier, `RS256`, `jwksUri` `https://<tenant>/.well-known/jwks.json` |
| Clerk | `issuer` is the Frontend API URL of the instance, `RS256`, `jwksUri` `<issuer>/.well-known/jwks.json`; add an `aud` through a JWT template |
| Supabase | `issuer` `https://<project>.supabase.co/auth/v1`, `audience` `authenticated`; asymmetric keys through `jwksUri`, or `HS256` with `secret` |
| Better Auth | the JWT plugin's JWKS (`jwksUri`), with the algorithm it signs with (for example `EdDSA`) |

**The same token on decisions.** `check`, `check:batch`, `authorize` and `snapshots` accept `Uniora-Actor-Token` too (`actorToken` option in the client): the
question must then be about the user in the token (`400 actor_mismatch` otherwise). With `authorize` the server takes the **session facts from the
token**, so a policy such as "recent sign-in with a second factor" reads what the provider signed instead of what your backend says (and a `session`
in the body is refused next to a token): `auth_time` becomes `session.authAgeSeconds`, `amr` becomes `session.methods`, `session.mfa` is `true` only
when `amr` has the `mfa` value of RFC 8176, and `acr` becomes `session.assuranceLevel` through your `acrLevels` map. A fact the token does not state is
unknown, and a policy that needs it refuses with a `stepUp`.

**What it does not give you.** A token is a bearer credential: the server does not remember used tokens (it relies on `exp`, so keep tokens short-lived), and it
verifies the user, not your backend's intentions. Hold tokens only as long as your auth provider's session does.

### Machine tokens: your own OAuth server instead of keys

If you already issue machine-to-machine tokens (Auth0 machine-to-machine applications, Okta, Azure AD, Keycloak, any OAuth 2.0 server with the
`client_credentials` grant), the server can accept those tokens in `Authorization: Bearer` instead of an UNIORA key. Nothing to distribute or
rotate on the UNIORA side: the secret stays with your identity provider.

```ts
createUnioraServer({
  …,
  machineTokens: [
    {
      provider: "machines",                       // a label for this provider (used in logs)
      issuer: "https://idp.example.com/",         // the exact `iss`
      audience: "uniora-api",                     // required, and DIFFERENT from the audience of `actorTokens`
      algorithms: ["RS256"],                      // pinned, exactly like `actorTokens`
      jwksUri: "https://idp.example.com/.well-known/jwks.json",
      // Which API client each machine is: the token's `sub` (or the claim `subjectClaim` names: `azp`, `client_id`) -> an API client id.
      clients: { "billing-app@clients": "apc_Pea5THFBmbEyvigq" },
    },
  ],
});
```

- The API **client** (created with `uniora server clients create`) is still where the power lives: its scopes and its organization list are the
  **ceiling**. A token may carry a `scope` (space-separated) or `scp` (list) claim that **narrows** them, never widens them; a token that names no
  UNIORA scope at all can call nothing, and **a token with no `scope`/`scp` claim at all gets no scopes** either (an explicit `null` refuses the token).
  If your provider narrows with a claim UNIORA does not read (Auth0's `permissions`, Azure's `roles`), set `allowUnscopedTokens: true` on that provider to
  give such tokens the client's whole scope set: the ceiling is then the only limit, so keep the client narrow. A subject that is not in `clients` is refused.
- **`subjectClaim` other than `sub`** (Azure AD and Okta put the application id in `azp` or `client_id`, and the tokens users get from the same application
  carry it too): the config then **requires** `requireClaims`, the claims that tell a machine token from a user's, for example `{ gty: "client-credentials" }`
  (Auth0) or `{ idtyp: "app" }` (Azure AD). `{}` is the explicit "I accept the risk".
- Everything else about verification is the same as for [end-user tokens](#verified-end-users-the-list-of-providers): pinned algorithms, keys only from the
  configuration, `exp` required, audience required. Every refusal is the same `401` as a bad key; `503 unavailable` when the keys cannot be fetched.
- **Disabling the API client cuts the machine off on its next request**, whatever the token's own expiry. Keep tokens short-lived anyway.
- The audit trail says it was a token: `metadata.via` has `credential: "token"` and a `keyId` such as `oidc_3f9a…` (a stand-in that names the machine, not a key).
  The rate limit is one bucket per machine identity.
- A server can accept keys and machine tokens side by side. The client library takes either: `createUnioraClient({ baseUrl, accessToken })`, where
  `accessToken` is a token or a function that returns the current one (called for every attempt, so cache and renew it yourself).
- **Not here: UNIORA does not issue tokens.** A token endpoint of our own would add nothing: the server already reads the database on every request, so a
  key is as revocable as it gets, and a JWT could only be revoked more slowly. If you want short-lived credentials, your OAuth server is the right place.

### Platform administration

The platform scope (staff roles and members, suspending an organization, opening support access) is available over the API under `/v1/platform`, for your
own admin panel. It is the most powerful thing the server can do, so it has more locks than anything else:

1. **Off unless configured.** Without the `platform` option every platform route answers `501 platform_not_configured`.
2. **A scope of its own**, `platform:admin`, on a client that may reach **every organization**.
3. **Never the key alone, never an asserted operator.** Every call carries the operator's **own token** in `Uniora-Actor-Token`, from one of the providers you
   list in `platform.providers` (use a separate staff provider; a customer-facing one cannot reach this). The platform service then applies its own rules to that
   operator: they must be a platform member holding the permission, nobody changes themselves, nobody hands out more than they hold, and the last active
   administrator stays.
4. **Step-up for every change.** The platform service asks "has this operator re-authenticated recently?" before any change (never before a read). The server
   answers it from the operator's token: `auth_time` within `maxAgeSeconds` (default 300) and `amr` containing `mfa` (`requireMfa`, default on), and optionally an
   assurance level (`minAssuranceLevel`, through the provider's `acrLevels`). Otherwise: `428 platform_step_up_required` with
   `WWW-Authenticate: Bearer error="insufficient_user_authentication"`. Your panel then sends the operator through your sign-in again and retries.

```ts
import { createPostgresPlatformStorage } from "@uniora/postgres";

createUnioraServer({
  …,
  actorTokens: [{ provider: "staff", issuer: "https://staff-idp.example.com/", audience: "uniora", algorithms: ["RS256"], jwksUri: "…", acrLevels: { "urn:mfa": 2 } }],
  platform: {
    storage: createPostgresPlatformStorage(pool),
    providers: ["staff"],
    stepUp: { maxAgeSeconds: 300, requireMfa: true },
    supportGrantablePermissions: ["reports.read", "members.block"], // required: the organization permissions support access may open ([] = none)
  },
});
```

`supportGrantablePermissions` has no default (an unlimited support grant is close to full access to every organization for 30 days); with `readOnly` on, platform
changes are refused too, including revoking a grant or suspending an operator, so for an incident use the CLI or the database. The first administrator is created once, with direct access to the database: `uniora platform init --admin staff:ana-staff`. The routes cover platform roles
and members, listing organizations, suspending/archiving/reactivating them, and opening or ending support access (the [reference](server-api.md#platform) has
every one, with executed examples). Platform audit entries carry the same `via` as everything else (`apiClientId`, `keyId`, `requestId`, `actorMode: "verified"`).
The client library takes `{ operatorToken }` on these calls.

### Webhooks

Webhooks send the events that happen (`membership.blocked`, `role.updated`, `invitation.accepted`, `organization.created`...) to a URL you register, so another
system can react without polling. They are built on the [outbox](outbox.md): the event is written in the same transaction as the change, so a rolled-back change
sends nothing and a committed one cannot lose its event.

They are managed **only** from the CLI and Studio (**Webhooks**: create, edit, enable/disable, rotate the secret, delete, and see the latest deliveries with a button to send a dead one again), never from an API route: an endpoint receives the events of every organization. Studio registers only public `https` URLs; a receiver on a private network is registered with the CLI and the `urlPolicy` of your config.

```bash
uniora webhooks create --url https://hooks.example.com/uniora --events 'membership.*,role.*' --orgs '*'
#   -> prints the signing secret ONCE (whsec_…); it is not shown again
uniora webhooks list | show <id> | update <id> --events '*' | disable <id> | enable <id> | delete <id>
uniora webhooks rotate-secret <id> --grace-seconds 86400   # the old secret keeps signing for a day, so receivers can switch with no downtime
uniora webhooks test <id>                                   # sends a signed webhook.test event
uniora webhooks deliveries --status dead                    # what gave up; `uniora webhooks requeue <deliveryId>` sends it again
uniora webhooks run [--once]                                # the worker, when it does not run inside the server
```

Turn it on with `webhooks` (in `createUnioraServer`, or `server.webhooks` in `uniora.config.mjs`); `listen()` then runs the dispatcher and `close()` stops it,
or set `run: false` and run `uniora webhooks run` elsewhere. Several dispatchers over the same database are safe: claims are leased.
**The dispatcher is the consumer of the outbox**: if you also consume it yourself, you will compete for the same events.

Which changes produce events: those made through the server's delegated routes and `organizations.create` (the access, team, policy and invitation services
enqueue them), with the event type equal to the audit action. Changes made directly with Studio or your own code produce events only if that code writes them
(`createAuditedStorage(storage, { actor, outbox: true })`). An invitation event names the invitation and a fingerprint of the address, never the address, the
token or the link.

**What the receiver gets**: a `POST` with this body and the [Standard Webhooks](https://www.standardwebhooks.com/) headers:

```
webhook-id: evt:7f1c…              the event id, the same on every retry: deduplicate on it (delivery is at least once)
webhook-timestamp: 1760000000      unix seconds of this attempt
webhook-signature: v1,K5oBfV…      base64 HMAC-SHA256 of "<id>.<timestamp>.<body>"; two values (separated by a space) while a rotation is in its grace
{"id":"evt:7f1c…","type":"membership.blocked","organizationId":"org_acme","createdAt":"…","data":{"actor":{…},"target":{…},"metadata":{…}}}
```

```ts
import { verifyWebhook } from "@uniora/core";

const ok = verifyWebhook({
  body: rawBody,                                   // the raw text, before any JSON.parse
  headers: { id: req.headers["webhook-id"], timestamp: req.headers["webhook-timestamp"], signature: req.headers["webhook-signature"] },
  secrets: process.env.UNIORA_WEBHOOK_SECRET!,     // pass both during a rotation
  toleranceSeconds: 300,                           // refuses a captured delivery replayed later
});
```

**Delivery**: any `2xx` is success; anything else (including redirects, which are never followed) is retried after 30 s, 1 min, 2 min... up to 1 h (a `Retry-After` on
`429`/`503` is honoured and does not count against the endpoint), and after 8 attempts the delivery is parked as `dead` for an operator to look at and `requeue`. An endpoint is
switched off (`too_many_failures`) only when it has failed 50 attempts in a row **and** gone an hour (`disableAfterMinutes`) without a delivery: a burst against a receiver that
blinked does not switch a feed off. An endpoint that did get switched off keeps collecting its events (up to 5000), and sends them when an operator enables it again.
The dispatcher does not run with `readOnly`. An event id that cannot be an HTTP header (non-ASCII, a line break) is sent under a stable stand-in `webhook-id` (`evt_<hash>`), and
the real id stays in the body.
Each attempt has a 10 s deadline, 10 deliveries run at once, and a delivered row is kept 7 days. All of it is configurable.

**The SSRF defense.** A webhook makes the server call a URL somebody typed, so it is treated as a request to a stranger's server: the URL must be `https`, carry no
credentials and not point at a private, loopback, link-local (the cloud metadata address included), carrier-grade NAT, multicast or documentation address, nor at an
internal name (`.internal`, `.local`, `localhost`). That is checked when the endpoint is registered **and again on every delivery, against the addresses the name
resolves to** (every one must be public, and the connection goes to the address that was checked, with the name for TLS: DNS rebinding does not help). Redirects are not
followed, the answer is read for at most a few KB, and nothing about the answer or the URL is put in an error (the URL may carry a secret in its path). For a
development receiver on this machine, `urlPolicy: { allowInsecureHttp: true, allowPrivateNetworks: true }`; the server refuses to start with both on and
`NODE_ENV=production`.

Rotating a second time inside a grace period ends the grace of the secret before it (only the previous one is kept). `uniora server start` and the CLI build the
webhook storage over the same database connection as everything else: to keep the signing secrets away from the role that serves organizations, run `createUnioraServer` with a
separate pool for `webhooks.storage`.

The signing secrets live in their own scope (`uniora_webhooks` schema in Postgres, `uniora_webhook_*` tables in SQLite), outside the organization tables, because the
worker must read them to sign: give the role that serves organizations no access to it ([`least-privilege-roles.sql`](sql/least-privilege-roles.sql)).

### A rate limit shared between instances

By default each process limits on its own, so N instances allow N times the configured rate. With `sharedRateLimit: true` (config file: `server.sharedRateLimit`) all
instances draw on one budget per API key, kept in the credential storage (table `rate_limits`; the database user needs to read and write it). An instance takes a small
lease of tokens (a tenth of the burst), spends it locally, and comes back for more, so the database is touched once per lease and not once per request. If the storage fails,
each instance limits on its own meanwhile and logs it; a request is never refused because the shared limiter is down.

### Optimistic concurrency

Members, roles, teams and policies carry a `version`, also sent as the `ETag`. Send it back as `If-Match` (the client: `ifMatch`)
and an edit made from a stale copy is refused with `412` and changes nothing:

```ts
const member = await uniora.members.get({ organizationId, membershipId });
await uniora.members.block({ organizationId, membershipId, reason }, { actor, ifMatch: member.version });
```

### Invitations end to end

Turn them on by telling the server how to build the link and how to send the e-mail (both are yours; see [Invitations](invitations.md)):

```ts
createUnioraServer({ …, invitations: { acceptUrl: (token) => `https://app.example.com/invite/${token}`, sender: mySender } });
```

1. An administrator invites: `uniora.invitations.create({ organizationId, email, roleIds }, { actor })`. The Owner role can never be
   offered, and the inviter must hold every permission of every role (`access_escalation` otherwise). The secret link goes to your
   `sender`; the response includes it only if you set `includeAcceptUrl: true` (do it only if **your** backend sends the e-mail).
2. The person opens the link in your app. Your backend asks `uniora.invitations.preview({ token })` to show the organization and roles
   before sign-in. Every unusable token answers the same `404 invalid_invitation`.
3. They sign up or sign in with your auth provider. Your backend calls `uniora.invitations.accept({ token, identity, verifiedEmail })`
   with the e-mail **your provider verified** for that identity: it must equal the invited address, which is what stops a leaked link
   from being used by another account. UNIORA re-checks what the inviter may still give and reports what it skipped.

`preview` and `accept` are application calls and need a client that may reach every organization, because the token names the
organization, not the caller.

### Errors, retries and idempotency

Errors are `application/problem+json` with a stable `code` and **never** an internal message ([the list](server-api.md#errors)). Branch on
`code`. The client retries on its own, but only where it cannot repeat a change: reads, calls the server refused before doing
anything (`429`, `503 overloaded`), and calls that carry an `Idempotency-Key`. A `503 timeout` on a change is **not** retried: the work
may have happened. Read the resource and decide.

## Configuring the server from the config file

`uniora server start` reads the `server` section of `uniora.config.mjs` (a JavaScript module, so secrets come from `process.env`). The flags `--default-provider`,
`--trusted-proxy-hops` and `--read-only` win over the file. The fine checks are the server's own and it fails closed, naming the option that is wrong.

```js
export default {
  database: { provider: "postgresql", url: process.env.DATABASE_URL },
  server: {
    defaultProvider: "main",
    trustedProxyHops: 1,
    trustedProxies: ["10.0.4.7"], // config-file only, like actorTokens: no --trusted-proxies flag
    sharedRateLimit: true,
    actorTokens: [{ provider: "main", issuer: "https://idp.example.com/", audience: "uniora", algorithms: ["RS256"], jwksUri: "https://idp.example.com/.well-known/jwks.json" }],
    requireVerifiedActors: true,
    machineTokens: [{ provider: "machines", issuer: "https://idp.example.com/", audience: "uniora-api", algorithms: ["RS256"], jwksUri: "https://idp.example.com/.well-known/jwks.json", clients: { "billing-app@clients": "apc_…" } }],
    invitations: { acceptUrl: (token) => `https://app.example.com/invite/${token}`, sender },
    platform: { providers: ["staff"], stepUp: { maxAgeSeconds: 300 }, supportGrantablePermissions: ["reports.read"] },
    webhooks: { run: true },
  },
};
```

`platform` and `webhooks` take their storage from the same database as everything else; `limits`, `policies`-style options are the ones of `createUnioraServer`.

## From your backend: `@uniora/client`

```ts
import { createUnioraClient } from "@uniora/client";

const uniora = createUnioraClient({ baseUrl: process.env.UNIORA_URL!, apiKey: process.env.UNIORA_API_KEY! });
```

- Every operation is a typed method (`uniora.members.assignRole(input, options)`), generated from the same route table the server runs, so
  an input the server would refuse does not compile and a new route appears the day it ships.
- It refuses to run in a browser, to send the key over plain `http:` (except to this machine), and to put the key in an error message.
- Timeouts (10 s), retries with backoff and `Retry-After`, `UnioraApiError` with `code`, `status`, `requestId` and `issues`;
  `UnioraConnectionError` when the server cannot be reached; `paginate()` to walk a list.

### The remote engine: guards without changing them

The Express and Next guards take an `AuthorizationEngine`. Give them one that asks the server:

```ts
import { createRemoteEngine } from "@uniora/client";

const engine = createRemoteEngine(uniora);   // same can / authorize / access.check as the local engine
app.delete("/vehicles/:id", requirePermission(engine, { permission: "vehicles.delete", resolve }), handler);
```

It answers like the local engine (a test compares them on the same data) and fails closed: `authorize()` never throws and returns
`indeterminate` when the server cannot be reached; `can()` throws, so an outage is an error, never an allow. The answers carry the
decision, the reason and `stepUp`, not the per-policy detail. Its key needs the `check` scope.

## Security model

**What the server defends against**, mapped to the OWASP API Top 10:

| Risk | Defence |
| --- | --- |
| Broken object level authorization | Every organization route checks the client's organization list **before** the handler runs, and an organization outside it answers like one that does not exist. The storage underneath isolates tenants again. |
| Broken authentication | Keys are 256-bit random, stored as SHA-256, compared in constant time, never cached, never logged; one `401` for every failure; failed attempts are throttled per source. |
| Broken object property level authorization | Responses are shaped by a declared schema: a field not listed never leaves the server. Requests are parsed strictly: an unknown field is refused. |
| Unrestricted resource consumption | The limits above, enforced before any database work; slow-client timeouts; a deadline per request. |
| Broken function level authorization | Each route has exactly one scope, and the scope check is in the pipeline, not in the handler. A test generated from the route table calls every route with every other scope and expects `403`. |
| Unrestricted access to sensitive flows | Sign-up is idempotent; invitation tokens are 256-bit, shown once, and every unusable one looks the same. |
| Security misconfiguration | The server refuses to start without TLS off loopback, refuses unknown options, sets `no-store`, `nosniff` and a locked-down CSP on every answer, and returns no internal message. |
| Improper inventory management | The route table is the one source of the server, the OpenAPI document and the client; a test fails when the committed copies differ. |

**Review notes worth knowing.** The pipeline was attacked from outside by three independent reviews; what they found is fixed and each fix has a test. The ones that change
behaviour: requests are routed on the path exactly as written (`//x/v1/...`, `/v1/./...`, `%2e%2e` are `404`, so a proxy rule on the raw path cannot be bypassed); `/readyz` shares one
probe between callers; the memory storage is for tests (it has no rollback, so a failed provisioning can leave a partial state: the databases do); a caller never chooses the id of a
role, a team or a team membership (the server generates them); and an `engine.onDecision` auditor is refused at start, because the identity of a decision comes from the caller.
The failed-authentication throttle is checked before the credential lookup and counted after it, so a burst of bad keys can overshoot the limit by what is in flight at that moment
(bounded by `maxInFlight`); an IPv6 client is counted by its /64.

**What it does not do**: issue tokens (use your OAuth server, above), manage webhooks or API keys over HTTP (on purpose), or read members, roles and teams as an end user. See the
[roadmap](roadmap.md).

### Hardening checklist

- [ ] TLS terminates at the server or at a proxy you declared (`--behind-tls-proxy` with the right `--trusted-proxy-hops`).
- [ ] The server's database user cannot change keys; Studio and the CLI use another one ([database users](#database-users)).
- [ ] One client per backend; each with the fewest scopes and the shortest organization list that works.
- [ ] Delegated calls use verified tokens (`actor:verified`), and `requireVerifiedActors` is on; `actor:assert` only on servers you control, never on a client that merely checks permissions.
- [ ] Keys in a secret manager, never in a repository, an image or a log; rotate them (they can expire: `--expires-in-days`).
- [ ] The default provider label is set and written down; it is never changed.
- [ ] Health checks point at `/healthz` and `/readyz`; logs go somewhere you read them and the `requestId` of a 5xx is findable.
- [ ] `uniora doctor` is clean, and you [anchor the audit head](hardening.md) outside the database.
- [ ] More than one instance? Turn on `sharedRateLimit`, or account for the per-process limit.
- [ ] Platform routes: a separate staff identity provider in `platform.providers`, `supportGrantablePermissions` listed, `platform:admin` only on the one client of your admin panel.
- [ ] Webhooks: receivers verify the signature (and the timestamp), deduplicate on `webhook-id`, and secrets are rotated with a grace period.

## What is not here yet

Tracked in the [roadmap](roadmap.md): delegated reads of members, roles and teams (today they are application calls; only policies can be read as an end user), and a published container image.
