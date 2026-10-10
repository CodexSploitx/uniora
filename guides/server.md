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
| **Who may call** | API clients and keys, managed in Studio or with `uniora server …` ([below](#api-clients-and-keys)) |

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

From code (for a custom setup, a framework or two database users):

```ts
import { createUnioraServer } from "@uniora/server";
import { createPostgresApiCredentialStorage, createPostgresStorage } from "@uniora/postgres";

const server = createUnioraServer({
  storage: createPostgresStorage(appPool),                       // organizations: the role of the server
  credentials: createPostgresApiCredentialStorage(readOnlyPool), // keys: it only READS them
  defaultProvider: "main",
  trustedProxyHops: 1,
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

The rate limiter is **per process**: with N instances the effective limit is N times the configured one. A shared limiter is on the
[roadmap](roadmap.md). A request that timed out keeps its concurrency slot until the work really ends.

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

### Changes on behalf of an end user

Changing who holds which power is a **delegated** call: the end user travels in `Uniora-Actor-Subject` (and `Uniora-Actor-Provider` if
you have no default), the client needs `actor:assert` as well as the scope of the call, and the services then apply the
[anti-escalation rules](access-admin.md) **to that user**: they can only give what they hold, never to themselves, never touch someone
who holds more power than they do. A key cannot do more than the user it speaks for.

```ts
await uniora.members.assignRole(
  { organizationId, membershipId, roleId },
  { actor: { subject: session.userId } },   // the verified signed-in user of YOUR app
);
```

Every audit entry keeps the end user as its `actor` and adds `metadata.via = { apiClientId, keyId, requestId }`, set by the server
inside the hash chain: you can always tell which backend relayed a change and which request it was.

**The risk delegated mode accepts, plainly:** a key with `actor:assert` can speak for **any user of its organizations**. That is why
the scope is separate and sensitive, why organization lists exist, and why a key that only checks permissions should never have it.
The server cannot verify an end user's identity by itself; verified end-user tokens are on the [roadmap](roadmap.md). Keep such keys
on servers you control and rotate them.

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

**What it does not do (yet)**: verify end users (delegated calls trust the actor header of a key that holds `actor:assert`); share its rate
limits between instances; sign or push events (webhooks); cover platform administration (it needs a step-up design). See the
[roadmap](roadmap.md).

### Hardening checklist

- [ ] TLS terminates at the server or at a proxy you declared (`--behind-tls-proxy` with the right `--trusted-proxy-hops`).
- [ ] The server's database user cannot change keys; Studio and the CLI use another one ([database users](#database-users)).
- [ ] One client per backend; each with the fewest scopes and the shortest organization list that works.
- [ ] `actor:assert` only on servers you control, never on a client that merely checks permissions.
- [ ] Keys in a secret manager, never in a repository, an image or a log; rotate them (they can expire: `--expires-in-days`).
- [ ] The default provider label is set and written down; it is never changed.
- [ ] Health checks point at `/healthz` and `/readyz`; logs go somewhere you read them and the `requestId` of a 5xx is findable.
- [ ] `uniora doctor` is clean, and you [anchor the audit head](hardening.md) outside the database.
- [ ] You run more than one instance only after accounting for the per-process rate limit.

## What is not here yet

Tracked in the [roadmap](roadmap.md): OAuth 2.0 client credentials with short-lived JWTs (opaque keys come first), verified end-user
tokens, platform administration over the API (it needs a step-up design), webhooks from the outbox, a shared rate limiter,
and delegated reads of members, roles and teams (today they are application calls; only policies can be read as an end user). A container image is not published yet.
