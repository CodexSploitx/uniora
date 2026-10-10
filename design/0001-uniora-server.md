# 0001 — UNIORA Server: a self-hosted authorization API

| | |
| --- | --- |
| Status | **Draft for review.** Nothing here is built yet. |
| Decisions recorded | 2026-10-10 (D1–D5 below) |
| Tracks | [`guides/roadmap.md`](../guides/roadmap.md) — "A standalone API server", "OAuth 2.0 client credentials", "Verified end-user tokens" |

## 1. The problem

Today UNIORA runs **inside** the host application: `@uniora/core` plus `@uniora/express` / `@uniora/next`, talking to the host's
database. Some teams want the opposite: UNIORA as **its own service**, deployed next to their product and reached only over HTTP,
so their codebase never imports it and their auth provider stays exactly where it is.

```text
Your backend ──HTTPS + API key──▶ UNIORA Server ──▶ its own Postgres / SQLite
     ▲                              (@uniora/core: engine, services, commands)
     └── your auth provider (Supabase, Clerk, Auth0, …) — unchanged
```

**Goals**

- A production-grade HTTP API over everything UNIORA already does: decisions (`can`, `authorize`, snapshots), organizations,
  members, roles, permissions, features, teams, policies, invitations, the audit log.
- Built for thousands of users from the first release: bounded, measured, tested adversarially. Not an MVP to be hardened later.
- **Self-hosted, one deployment per customer, its own database.** This keeps "your data stays in your database" true and keeps
  "a hosted service" out of scope ([roadmap](../guides/roadmap.md)).

**Non-goals**

- Authenticating end users. UNIORA answers "what can this identity do", never "who is this".
- A multi-tenant hosted SaaS run by us.
- Replacing the in-process packages. `@uniora/express` / `@uniora/next` stay first-class; the server is another way to deploy.

## 2. Decisions

| # | Decision | Notes |
| --- | --- | --- |
| D1 | **Opaque API keys first.** OAuth 2.0 client credentials with JWT access tokens come later. | Keys are revocable at once (the server already reads the database on every request). JWT is tracked in the roadmap. |
| D2 | **Two end-user identity modes in the contract from v1**: *asserted* (the backend says who the user is) and *verified token* (UNIORA verifies the user's JWT). **Asserted is implemented first.** | §6. Verified token is in the roadmap; v1 rejects it with a stable code instead of ignoring it. |
| D3 | **Studio manages API clients and keys** (create, rotate, revoke, disable), with a CLI equivalent for automation. | §9. |
| D4 | One server per customer, its own database, stateless processes that scale horizontally. | §11. |
| D6 | **The identity provider is an opaque label, optional in requests.** The server is configured with a default label; requests may send only `subject`. | §6. The label never has to name the vendor, and no request needs to carry it. |
| D7 | **Every endpoint is documented with examples, and the examples are tested.** | §13. Documentation is part of "done" for every route, not a follow-up. |
| D5 | **The server is a transport for the existing services and command layer, never a second implementation.** | Changes go through `runAccessCommand`, `runTeamCommand`, `runPolicyCommand`, the invitation service and `createOrganizationWithOwner`. Reads go through the engine and repositories. No route writes through a raw repository. |

D5 is what makes this tractable and safe. The command layer already does the hard part:
- The actor and the organization come from authentication, never from the request body.
- Parameters are checked field by field and **unknown fields are rejected**.
- The anti-escalation rules of [delegated administration](../guides/access-admin.md) apply to the actor.
- Every domain has an error→HTTP mapper (`accessErrorToHttp`, `teamErrorToHttp`, `policyErrorToHttp`, `invitationErrorToHttp`,
  `platformErrorToHttp`).

The server adds what an HTTP boundary needs: authentication of the caller, scopes, tenant scoping, limits and a stable contract.

## 3. What we learned from others

We read the source of three open-source systems and searched for documentation on the rest. The documentation sites were not
reachable from the research environment, so treat those rows as secondary sources to confirm before relying on details. We take
**design ideas only**; no code is copied (Logto is MPL-2.0, OpenFGA and SpiceDB Apache-2.0).

| Who | How the API caller authenticates | Worth adopting | Worth avoiding |
| --- | --- | --- | --- |
| **Logto** (source, `logto-io/logto@a67d190`, `packages/core/src/middleware`) | OAuth2 machine-to-machine apps. The JWT is verified locally against the JWKS with a pinned issuer and audience; `sub === client_id` marks an app caller. | Every route declares zod guards for query, params, body **and response**. The response guard **strips undeclared properties** and fails the request if the shape is wrong (`koa-guard.ts`). Audit entries can carry an idempotency key so a retry records once (`koa-audit-log.ts`). | The Management API requires a single `all` scope: no least privilege. A `development-user-id` header skips token validation outside production (`koa-auth/index.ts`). We ship **no** bypass of any kind. |
| **OpenFGA** (source, `openfga/openfga@526995e`) | Pre-shared keys or OIDC. | Pre-shared keys are kept as SHA-256 digests and compared in constant time against **all** of them, without early return (`internal/authn/presharedkey`). OIDC pins RS256 and requires `exp` and `aud` (`internal/authn/oidc`). **Everything is bounded**: 100 tuples per write, 512 KB per message, 3 s and 1000 results for listings, 50 checks per batch (`pkg/server/config/config.go`). It authorizes its own API calls with its own model (`internal/authz`). | A pre-shared key carries no identity and no scopes: you cannot tell who did what. |
| **SpiceDB** (source, `authzed/spicedb@ee99672`) | Pre-shared key. | **Refuses to start without a key** and rejects empty keys (`pkg/cmd/server/server.go`). Read-only mode (`internal/middleware/readonly`). Admission control that sheds load when memory is high (`internal/middleware/memoryprotection`). Per-request consistency tokens (ZedTokens) against stale permission reads. | Same coarseness as OpenFGA: one key does everything. |
| **Auth0** (docs, secondary) | Machine-to-machine apps, client credentials, short-lived JWT, scopes per endpoint (`read:users`, …). | Per-endpoint scopes; token quotas per application **and per organization**; 429 with a leaky bucket. | — |
| **Stripe / GitHub** (docs, secondary) | Opaque, prefixed keys. | Restricted keys with Read / Write / None per resource. Rotation with a grace period where both keys work. A prefix plus a CRC32 checksum so scanners find leaked keys with almost no false positives. | — |

The common thread: **identify every caller, give it the least power, bound every request, verify every token strictly, keep no
backdoors**, and make the contract machine-checked.

## 4. Threat model

**Assets**: the authorization data, the hash-chained audit log, API secrets, and above all the **ability to grant power**.

**Adversaries**:
- Whoever holds a leaked key.
- An end user of the host app trying to reach other users' or organizations' data through it.
- A buggy or compromised host backend.
- A network attacker.
- A noisy client or organization exhausting the server.
- An insider with database access, partly mitigated by the existing least-privilege roles and audit anchoring.

Mapped to the [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/):

| Risk | Mitigation in this design |
| --- | --- |
| API1 Broken object-level authorization | Keys are scoped to organizations (§5). The organization in the path must be in the key's allowlist **before** anything else runs. The services then check the actor's rights in that organization. An object of another organization answers exactly like a missing one (`404 membership_not_found`), as the services already do. |
| API2 Broken authentication | Prefixed keys with a checksum, hashed at rest, constant-time comparison, one uniform `401`. No bypass flags. Fail-closed boot. Verified tokens (later) pin algorithm, issuer and audience, and require `exp`. |
| API3 Broken object property-level authorization | Input: the command shapes reject unknown fields. Output: every response passes through a declared schema that **drops undeclared properties** (Logto's lesson). Secrets are returned once, at creation, and never again. |
| API4 Unrestricted resource consumption | Explicit limits on everything (§8), a per-key token bucket and concurrency cap, global admission control, `429` / `503` with `Retry-After`. |
| API5 Broken function-level authorization | A static route table where every route names exactly one scope. A test fails if a route has none, and another calls every route with every *other* scope and expects `403`. Deny by default. |
| API6 Sensitive business flows | Ownership transfer, invitations and role grants run only in delegated mode (a real actor, anti-escalation rules). They are rate-limited separately. Platform commands wait for a step-up design (§7). |
| API7 SSRF | v1 makes no outbound requests. Later JWKS fetches use a fixed issuer allowlist; later webhooks need an SSRF guard. |
| API8 Security misconfiguration | Secure defaults. The server refuses to start insecurely (§11). No CORS: server-to-server only. Security headers. No stack traces in responses. |
| API9 Improper inventory | One versioned API (`/v1`) with an OpenAPI document generated from the code and diffed in CI. Deprecations follow the same "only ever add" rule as error codes. |
| API10 Unsafe consumption of APIs | Later: identity-provider responses (JWKS, discovery) are validated strictly and cached with bounds. |

## 5. Callers: API clients and keys

An **API client** is a named machine principal: "billing-backend", "signup-worker". It owns:

- **Scopes**: what it may call (`check`, `organizations:read`, `organizations:create`, `members:write`, `actor:assert`, …).
  The full list is generated from the route table.
- **Organization allowlist**: `*` or a list of organization ids. This is the main defence against API1, the equivalent of
  Auth0's organization-scoped tokens and Stripe's restricted keys.
- **Status**: `active` or `disabled`. Disabling stops every key at once.
- **Up to two active keys**, so it can rotate with no downtime: create the new key, deploy it, revoke the old one.

**Key format**

`uniora_sk_<keyId>_<secret><checksum>`

- `keyId`: 16 random base62 characters, used for lookup and safe to show.
- `secret`: 32 random bytes (256 bits) in base62.
- `checksum`: CRC32 of everything before it, 6 base62 characters.

The prefix lets secret scanners find leaked keys. The checksum lets the client library and the server reject typos and random
garbage **before touching the database**.

**Storage**

- Only `SHA-256(secret)` is stored, plus `keyId`, a 4-character hint, `createdAt`, `createdBy`, `expiresAt?`, `revokedAt?`,
  `revokedBy?` and `lastUsedAt`.
- A fast hash is right here: the secret has 256 bits of entropy. Slow hashes (bcrypt, argon2) exist to protect low-entropy
  passwords, and would only add latency to every request.
- `lastUsedAt` is updated at most once every few minutes per key, to avoid a write per request.
- The secret is shown **once**, at creation. There is no way to read it again.

**Verification on every request**

1. Parse the header and check the format.
2. Check the checksum.
3. Look up by `keyId`.
4. Compare the hashes in constant time.
5. Check that the key is not revoked or expired and the client is active.
6. Produce the principal.

Every failure answers the same `401 unauthenticated`, so the server is not an oracle. Repeated `401`s from one source address are
throttled. There is no verification cache by default, so revocation takes effect on the next request. An optional cache with a
TTL of a few seconds can be turned on, with that delay documented.

**Credential storage is its own scope**, like [the platform](../guides/platform.md):
- Its own tables (Postgres schema `uniora_api`, SQLite `uniora_api_*`) and its own repository, outside `UnioraStorage`. Code that
  serves organizations never holds it.
- A least-privilege database role: the server only reads credentials and updates `lastUsedAt`.
- Implemented in Postgres and SQLite and pinned by conformance tests, like every other storage.

**Later (D1, roadmap):** OAuth 2.0 client credentials. Either the server issues short-lived JWT access tokens (RFC 9068;
algorithm pinned, `exp` ≤ 15 min, `aud` = the server) or it accepts tokens from the customer's own identity provider, verified
like OpenFGA's OIDC mode (issuer, audience and algorithm pinned, `exp` required, subject mapped to an API client). The principal
model above does not change, so scopes and organization allowlists carry over as they are.

## 6. Who the end user is (D2)

Calls come in two kinds:

**Application calls**
- The actor is the API client itself, recorded as the identity `{ provider: "uniora-api", subject: <clientId> }`.
- Used for: decisions for any identity (`check`, `authorize`, snapshots), provisioning (create an organization with its Owner),
  and reads for sync jobs.
- Each kind is guarded by its own scope.

**Delegated calls**
- The actor is an end user. Every change to power is a delegated call: assign a role, invite, block, edit a role, transfer
  ownership.
- The services then apply the [anti-escalation rules](../guides/access-admin.md) **to that user**: a key cannot do more than the
  user it speaks for.
- The actor travels in its own headers, never in the body that the command checks:

| Mode | Header | Status in v1 |
| --- | --- | --- |
| Asserted | `Uniora-Actor-Provider` and `Uniora-Actor-Subject` | Implemented. Needs the `actor:assert` scope. |
| Verified token | `Uniora-Actor-Token: <the end user's JWT>` | In the contract. v1 answers `501 actor_token_unsupported`. |

In verified-token mode UNIORA verifies the JWT against the provider configured for the deployment (issuer, audience and
algorithm pinned, `exp` required) and derives the identity itself. A leaked key can then no longer speak for an arbitrary user.

**The provider label (D6)**: an identity is always stored as `provider` + `subject`. The provider:
- keeps subjects of two auth systems from colliding;
- makes identity linking (migrating provider) possible;
- keeps internal principals apart from end users.

It is an **opaque label chosen by the operator** (`"main"`, `"p1"`, …), not the vendor's name. It reveals nothing about the
auth provider and nothing about the database. Hiding the vendor would protect little anyway: login redirects and the shape of the
ids (`user_…`, `auth0|…`) give it away.

The server is configured with a **default label**, so requests may omit it:

```json
{ "identity": { "subject": "3f2c9a10-8b1e-4c2d-9f7a-1e2b3c4d5e6f" }, "organizationId": "org_acme", "permission": "vehicles.delete" }
```

- The server fills the default label in before anything else, and stores and compares the full identity.
- The default never changes once data exists. A second auth system must send its own label explicitly.
- With no default configured and no label sent, the request is refused (`400 identity_provider_required`); the server never guesses.
- The same applies to the `Uniora-Actor-Provider` header.

**Reserved providers**: an asserted actor whose provider is `uniora-api`, `uniora-studio` or `uniora-platform` is refused, so nobody
can impersonate an internal principal in the audit log.

**The risk asserted mode accepts, stated plainly**: a key with `actor:assert` can speak for any user of the organizations in its
allowlist. That is why the scope is separate, allowlists exist, and verified-token mode is next on the roadmap. Keys used only for
`check` should never hold `actor:assert`.

**Audit**: delegated entries keep the end user as `actor` and add a reserved `via` object to `metadata`:
`{ apiClientId, keyId, requestId }`. The server sets it and the client cannot. It lives inside the hash chain, so it is
tamper-evident like the rest of the entry.

## 7. The API (v1)

**Conventions**

- **Transport**: HTTPS, JSON (`Content-Type: application/json` required), paths under `/v1`.
- **Errors**: `application/problem+json` (RFC 9457): `{ type, title, status, code, requestId }`.
  - `code` is the existing stable `UnioraError` code. A `403` never says why, as today.
  - **The internal error message is never returned.** Some `core` messages name identities (`Identity <provider>:<subject>
    already has a membership…`). If a host forwarded those to a browser, it would leak who is a member and their provider. The
    response carries only the code and a generic title.
  - The full message goes to the server's structured log, keyed by `requestId`, where only operators read it.
- **Optimistic concurrency**: `expectedVersion` is exposed as `ETag` / `If-Match`.
  - A version conflict (`*_version_conflict`) answers `412`.
  - A write without `If-Match` is allowed, matching the libraries.
- **Idempotency** (Stripe's model), on every `POST` that creates something:
  - `Idempotency-Key` is kept per API client for 24 h.
  - The same key with a different body answers `422 idempotency_key_reused`.
  - A request still running under the same key answers `409 idempotency_in_progress`.
  - A replay returns the stored response.
- **Pagination**: the existing keyset cursors, as an opaque `cursor` plus `limit` (max 100).
- **Tracing**: `Request-Id` is returned on every response and accepted from the caller if it is well formed.

**Routes**

Each route is bound to **one** command or read and **one** scope. The client never picks the command: as in `platformCommand`,
it is fixed by the route. Bodies are the existing command shapes (`ACCESS_COMMANDS`, `TEAM_COMMANDS`, `POLICY_COMMANDS`), and the
OpenAPI document is generated from those shapes, so the contract cannot drift from the validation.

| Group | Examples | Kind | Scope |
| --- | --- | --- | --- |
| Decisions | `POST /v1/check` (`can` / `access.check`), `POST /v1/authorize` (with policies), `POST /v1/snapshots`, `POST /v1/check:batch` (≤ 50) | application | `check` |
| Provisioning | `POST /v1/organizations` (`createOrganizationWithOwner`) | application | `organizations:create` |
| Reads | `GET /v1/organizations/{org}`, `/members`, `/roles`, `/permissions`, `/features`, `/audit-log` | application or delegated | `organizations:read`, `audit:read` |
| Members and roles | `POST /v1/organizations/{org}/members/{m}/roles`, `…/block`, `…/suspend`, `PUT /v1/organizations/{org}/roles/{r}/permissions` | delegated | `members:write`, `roles:write` |
| Teams, policies | `runTeamCommand`, `runPolicyCommand` routes | delegated | `teams:write`, `policies:write` |
| Invitations | invite, resend, revoke, plus the public preview and accept used by the host | delegated | `invitations:write` |

- **Reads in delegated mode** are deny-by-default: the actor must be an active member and hold the read permission for that
  resource. The exact keys are an open question (§14).
- **Platform commands are not in v1.** The platform service supports a step-up (MFA) hook. A server cannot perform MFA itself,
  so this needs its own design: probably a short-lived, signed step-up assertion from the host. It must be designed before any
  platform route ships.
- **No route manages API keys.** A key that can mint keys is a privilege-escalation path. Keys are managed from Studio and the CLI
  only (§9).

## 8. Limits and resilience

Defaults, every one configurable, all enforced before any database work:

| Limit | Default |
| --- | --- |
| Request body | 64 KB |
| Page size | 25 (max 100) |
| Checks per batch | 50 |
| Request deadline | 5 s; a request that times out answers `503` and is cancelled |
| Per-key rate | Token bucket, 50 req/s with a burst of 100 → `429`, `Retry-After`, `RateLimit-*` headers |
| Per-key concurrency | 20 in-flight requests |
| Failed authentications per source address | Throttled after 20/min |
| Global admission | Rejects with `503` when in-flight requests or event-loop lag pass a threshold (SpiceDB's lesson) |
| Header size and timeouts | Bounded headers and timeouts against slow-client attacks |

In v1 the rate limiter is per process: with N instances the effective limit is N times the configured one. This will be
documented. A shared limiter (Postgres-backed) is a later step.

## 9. Studio and CLI: managing API clients (D3)

**Studio**, a new **API clients** section:

- **List** clients with name, scopes, organization allowlist, status, last use, and the hints of their keys.
- **Create a client**: pick scopes, each with a plain description of what it allows. `actor:assert` gets an explicit warning.
- **Create a key**: shown **once**, with a copy button and "you will not see this again".
- **Rotate**: create a second key; Studio reminds you to revoke the old one.
- **Revoke a key** or **disable a client**: takes effect on the next request.

Every action is audited (`api_client.created`, `api_key.created`, `api_key.revoked`, …). `--read-only` blocks all of them.
Studio never displays a hash or a secret after creation.

**CLI**, the same operations for automation and bootstrap:

```bash
uniora server clients create --name signup-worker --scope organizations:create --orgs '*'
uniora server keys create --client signup-worker          # prints the secret once; --json for CI
uniora server keys revoke <keyId>
```

## 10. Client library

`@uniora/client` is typed from the OpenAPI document:

- Timeouts by default.
- Retries with backoff only for idempotent requests, or with an automatic `Idempotency-Key`.
- Errors come back as `UnioraApiError` with the same `code`s as the libraries.
- It refuses to run with a secret key in a browser.

It also provides a **remote `AuthorizationEngine`**: `can`, `authorize` and `access.check` over HTTP. The existing
`@uniora/express` / `@uniora/next` guards then work unchanged against a server.

## 11. Server implementation

**Package** `@uniora/server`:

- `createUnioraServer({ storage, credentials, … })` returns a Node `http` handler and a Fetch handler.
- `npx uniora server start` runs it.
- A container image: non-root, read-only filesystem, health check.

**Framework** (open question, §14). The recommendation is Node's `http` with a small internal router and no framework, consistent
with the CLI's own argument parser: fewer dependencies is a smaller supply chain, and we need explicit control over limits anyway.

**Fail-closed boot.** The server refuses to start when:
- Migrations are pending or modified (it reuses the ledger checks).
- There is no TLS and no explicit "behind a TLS proxy" setting with a trusted proxy list.
- It would bind to a public interface without being told to.

**Operations**:

- **Health**: `/healthz` is liveness; `/readyz` checks the database and migrations.
- **Logs**: structured JSON logs that redact `Authorization` and the `Uniora-Actor-*` headers.
- **Telemetry**: optional OpenTelemetry metrics and traces.
- **Shutdown**: graceful shutdown that drains in-flight requests.
- **Read-only mode**: rejects every write with `503 read_only`. This is SpiceDB's idea, useful during migrations and incidents.

**Consistency.** Every read goes to the single primary database, so a revocation is visible to the next request. Zanzibar's "new
enemy" problem (a stale cache granting access after revocation) does not arise in v1, which caches no decisions. If read
replicas or decision caches are ever added, they need consistency tokens first (zookie-style), not after.

## 12. Performance targets

"Thousands of users" is a load we measure, not a claim we make.

**Targets**, per instance, Postgres on the same network, measured with an open-loop load generator and recorded next to the
numbers already in [`guides/performance.md`](../guides/performance.md):

| Endpoint | Target |
| --- | --- |
| `check` | p99 < 20 ms at 500 req/s |
| `snapshots` | p99 < 50 ms |
| Write commands | p99 < 100 ms |

**Scaling**: the process is stateless, so it scales out. The database is the limit, with the indexes the guides already document.

## 13. How we verify it

1. **Contract tests.**
   - The route table is complete: every route has a scope, a command or read, a request schema and a response schema.
   - The generated OpenAPI is diffed in CI.
2. **API conformance suite.** It runs the whole server against memory, SQLite and Postgres, as the storage conformance suite does
   today.
3. **Security battery, generated from the route table** so a new route is covered automatically. Each item maps to the OWASP risk
   of §4.
   - Every organization route called with another organization's ids (API1).
   - Every route called with every scope except its own (API5).
   - Unknown and duplicated fields, oversized bodies and deep JSON (API3/API4).
   - Malformed, truncated, wrong-checksum, revoked, expired and disabled keys all answer the same `401`, with a timing check (API2).
   - Idempotency races, rate-limit and concurrency abuse, slow-client timeouts.
   - Reserved-provider impersonation.
   - No response body ever contains an identity that the caller did not send, or an internal error message.
4. **Mutation checks**: each guard is removed on purpose and must make a test fail, as was done for the SQLite last-Owner guard.
5. **Adversarial review rounds** against the running server before the first release, as for the earlier security reviews.
6. **Load tests** against the targets of §12.

## 14. Documentation of every endpoint (D7)

A route is not done until it is documented. Two layers, both generated from the same route table so they cannot drift:

1. **Reference** (`guides/server-api.md` plus the OpenAPI document). For each endpoint:
   - method and path, the scope it needs, and whether it is an application or a delegated call;
   - every field of the request and response, with types and limits;
   - every error `code` it can return, with its HTTP status and what to do about it;
   - a complete example request (`curl` and `@uniora/client`) and the exact response.
2. **Guides** (`guides/server.md`) for the flows, not the endpoints:
   - deploy and configure the server (default provider label, TLS, limits);
   - create API clients and keys in Studio or the CLI, rotate, revoke;
   - the signup flow (create an organization with its Owner);
   - checks and snapshots from a backend;
   - delegated changes with the actor headers;
   - invitations end to end;
   - errors, retries and idempotency;
   - hardening checklist.

**The examples are tests.** Every example in the reference runs in CI against a real server (SQLite and Postgres) and its response
is compared with the documented one. A change that breaks an example breaks the build, so the documentation cannot go stale.

## 15. Phases

| Phase | Ships |
| --- | --- |
| 1 | Credential storage (Postgres + SQLite + conformance). Studio and CLI management. The server skeleton: authentication, scopes, organization allowlists, default provider label, limits, errors, health, fail-closed boot. Decisions (`check`, `authorize`, snapshots) and reads. Their documentation and tested examples. |
| 2 | Delegated commands (access, teams, policies, invitations). Provisioning. Idempotency. The generated OpenAPI. `@uniora/client` with the remote engine. |
| 3 | Verified end-user tokens (D2). OAuth 2.0 client credentials / JWT (D1). Platform commands with a step-up design. Webhooks from the outbox. A shared rate limiter. |

Each phase ships only with its part of the conformance and security suites green **and every route it adds documented with tested examples**.

## 16. Open questions

1. **HTTP framework**: no framework (recommended), Fastify or Hono.
2. **Read permissions in delegated mode**: which keys (`members.read`, `roles.read`, `audit.read`, …), and whether any read is
   allowed to every active member. Default deny.
3. **Rate-limit defaults** (§8): to be tuned with the load tests.
4. **Verified-token configuration**: one identity provider per deployment, or several (one per auth adapter), each with its own
   issuer and audience.
