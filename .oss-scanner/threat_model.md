# UNIORA threat model

## What this project does and what it must guarantee

UNIORA ("Universal Organization & Authorization") is a TypeScript monorepo that answers one question for other
applications: *given an identity and an organization, what may this person do, and what has the organization
unlocked?* It is **not** an authentication provider. It receives the user id that Supabase, Clerk, Auth0 or Better
Auth already verified, and decides ALLOW or DENY from organizations, memberships, roles, permissions, teams,
policies and features stored in the operator's own database (PostgreSQL or SQLite; there is no UNIORA cloud).

It runs in two modes that share the same engine: **embedded** (`@uniora/core` and the adapters, called as
`engine.can()` / `access.check()` or through the Express and Next guards) and a **standalone HTTP service**
(`@uniora/server`, called with API keys or machine tokens, typed by `@uniora/client`).

**The security goal is that UNIORA is an authorization engine that is deny-by-default.** It must never grant access it
cannot justify. Unknown permission, malformed key, missing membership, wrong organization, suspended or archived
organization, blocked or suspended member, unregistered feature: the answer is always DENY, never a fallback to ALLOW.
Any path that turns a DENY into an ALLOW, or lets a caller do more than they were granted, is the bug class we care about
most. A UNIORA that fails *open* is worse than one that is down.

## What matters most (and the severity we assign)

Rate by demonstrated impact for a caller with the *lowest* privilege that can reach the path.

1. **Authorization bypass** — **critical** when an unauthenticated caller, or a member without the permission, gets an
   ALLOW (or performs the guarded mutation) from `AuthorizationEngine.can`, `access.check`, the policy engine, feature
   and quota checks, the Express guards (`requirePermission`, `authorize`), the Next helpers (`authorizeRoute`,
   `assertAccess`), `POST /v1/check`, or the SQL functions used for PostgreSQL row-level security (they must give the
   same answers as the engine). Includes: permission-key normalization or implication bugs, a dynamic permission that
   resolves to `undefined`/`""` being allowed, errors or exceptions that resolve to ALLOW, a decision cached or reused
   across organizations or identities, and the engine and the SQL functions disagreeing in the permissive direction.
2. **Cross-organization (tenant) access** — **critical** when one organization reads or changes another's data
   (memberships, roles, teams, policies, invitations, profiles, audit log, webhooks), or when an organization id taken
   from request input is trusted over the one the caller is authorized for. API clients are scoped by an organization
   list; an `orgs` restriction that can be sidestepped is as serious as a missing check.
3. **Privilege escalation** — **high to critical**: a member obtaining a role or permission they were not given,
   including through delegated administration (nobody may hand out a role they do not hold, change their own roles, or
   touch someone above them), invitations (an invitation must not grant the Owner role, and a token must be single-use,
   unguessable and bound to the verified e-mail), team scope and hierarchy, role templates and system roles, identity
   links (a link must never merge two people silently), support grants (temporary, audited, scoped) and platform
   administrators (staff power must stay outside any organization). A low-privilege API client minting itself a broader
   scope or key is in this class.
4. **Organization manipulation** — **high**: breaking the invariants of an organization. Every organization has exactly
   one protected **Owner**; the last active Owner can never be removed, blocked, demoted or suspended (this is enforced
   with a database constraint, so test concurrent requests too); the Owner role can only be granted through
   `assignOwnerRole` / `transferOwnership`; `suspended` and `archived` organizations must deny **everyone**, the Owner
   included. Orphaning an organization, creating a second Owner, or reviving a suspended organization without authorization
   is a finding.
5. **Audit log integrity** — **high**: the audit log is append-only and hash-chained. A way to alter or delete entries
   without `verifyIntegrity()` / `uniora doctor` detecting it, or to skip writing the entry for a privileged change, is
   in scope. (Truncating the newest entries is a documented limit unless the operator exports an anchor; see
   `guides/audit-log.md` and `guides/hardening.md`.)
6. **Secrets and tokens** — **high**: API keys (`uniora_sk_…`, only a fingerprint is stored), machine tokens and actor
   tokens, invitation tokens, webhook signing secrets, Studio's launch token, SMTP credentials. Look for leaks in logs,
   errors, audit entries or responses; weak comparison or generation; replay; missing expiry or revocation; and
   timing differences.
7. **Server-side request forgery and injection** — **high**: webhook delivery (`packages/core/src/webhook`,
   `packages/server/src/webhooks`) must refuse private, loopback, link-local and metadata addresses, including after DNS
   resolution and redirects. SQL injection in the PostgreSQL and SQLite adapters (search, `LIKE`, filters, ordering,
   pagination) is **critical** when reachable by an API client or an end user.
8. **Denial of service** — **medium** only when a small request makes the service unavailable or exhausts memory/CPU
   (unbounded lists, unbounded policy or implication graphs, pathological regular expressions, missing request-size or
   rate limits on `@uniora/server`). The engine documents hard limits (for example implication depth 8, 20 per
   permission); exceeding a documented limit without being rejected is a finding.

If a report starts from an account that already holds the Owner role or a platform administrator, state exactly which
*additional* power is gained: the Owner legitimately has every permission in its own organization.

## Where untrusted input enters

- HTTP requests to `@uniora/server` (`packages/server/src`, routes in `src/routes/`; the API is described in
  `guides/server-api.md` and `guides/openapi.json`): path and query parameters, JSON bodies, headers, API keys, machine
  tokens, actor tokens, and the end-user identity an API client asserts.
- Anything a *backend* forwards to the engine in embedded mode: identity subjects, organization ids, permission keys,
  resource attributes and request context supplied to policies.
- Invitation links and tokens, the e-mail the invitee claims, webhook target URLs and payloads, profile fields (name,
  e-mail, avatar URL) and everything stored by a tenant (role names, team names, policy definitions).
- The CLI reads `uniora.config.mjs` and `.env` from the current directory: running it in an untrusted repository is
  documented as unsafe, so a malicious config is **not** a finding by itself.

Treat the auth provider as trusted to say who the user is (UNIORA never sees passwords or sessions), and an API client as
trusted only for its scopes and organization list. Host operators, whoever holds the database admin credentials, and
whoever can write the server's configuration are trusted. A database administrator editing rows directly can change
anything; only the protections the code or the SQL migrations claim to provide (constraints, triggers, hash chain,
least-privilege roles in `guides/sql/least-privilege-roles.sql`) are in scope.

## Components, most to least important

- `packages/core/src/authorization`, `access`, `policy`, `permission`, `role`, `membership`, `organization`,
  `team`, `invitation`, `platform`, `support-grant`, `identity-link`, `entitlement`, `feature`, `audit`-related code:
  the engine. Highest priority.
- `packages/server`: the HTTP surface, API clients, scopes, organization lists, machine and actor tokens, webhooks.
- `packages/database/postgres` and `packages/database/sqlite` (migrations, constraints, triggers, RLS functions,
  queries) and `packages/database/conformance` (the shared contract both must satisfy).
- `packages/express`, `packages/next`, `packages/client`, `packages/react` (`<Can>`/`<Feature>` are UX only; a finding
  needs a *server-side* guard that can be bypassed), and the identity adapters in `packages/adapters/*`
  (`toVerifiedEmail()` must only ever return a verified e-mail).
- `packages/cli` and `apps/studio`: operator tools meant for loopback, behind the operator's own access control. A
  finding here needs an attacker who is *not* already the operator (for example a cross-site request, a missing check on
  Studio's launch token, or injection through stored data).
- Lower priority or out of scope: `apps/playground`, `examples/`, `site/` (static landing page), `test/` and
  `*.test.ts` fixtures (intentionally permissive), `guides/`, and third-party dependencies unless a vulnerable code path is
  reachable through UNIORA. A dependency advisory with no demonstrated path is not a finding.

## How to exercise it

The image has Node 22, pnpm (the version in `packageManager`), the installed dependencies and a built repository in `/src`
(every package consumes the others through `dist/`; after editing a package run `pnpm --filter <name> build`). There is no
network at scan time, so use only what is cached.

- **Memory and SQLite need nothing**; the engine and server tests run against them. A PostgreSQL 16 server is installed:
  run `uniora-pg start`, then `pnpm -r test` (or `pnpm --filter @uniora/server test`). `TEST_DATABASE_URL` and
  `DATABASE_URL` are already set to the local server. The suites truncate `TEST_DATABASE_URL`, so never point it at data
  you care about.
- The most useful reproducer is a failing Vitest test next to the code (`*.test.ts`), for example
  `packages/core/src/authorization/engine.test.ts`, `packages/core/src/policy/*.test.ts`,
  `packages/server/src/battery.test.ts`, `packages/server/src/hardening.test.ts` and
  `packages/database/conformance` (run the same case against memory, SQLite and PostgreSQL). Prefer the in-memory storage
  for core logic and SQLite for the server so the reproducer is self-contained.
- To reproduce over HTTP, start the server with SQLite: `npx uniora init --provider sqlite && npx uniora migrate`, then
  `npx uniora server clients create …`, `npx uniora server keys create …` and `npx uniora server start` (see
  `guides/server.md`). Use synthetic organizations, users and keys only.
- `guides/concepts.md` explains the model, `guides/hardening.md` lists the controls that deliberately live outside the code,
  and `SECURITY.md` lists what the maintainers consider in scope.

## Findings and patches

- Include the commit, exact source locations, the minimal sequence of calls (storage setup, organization, memberships,
  roles, the call that should have been DENY), expected versus observed result, and the impact in terms of the model above.
  Say whether it needs the embedded engine or `@uniora/server`, and which configuration it depends on (for example
  `ownerRequiresRegisteredPermission`, delegated administration on or off, API client scopes).
- A **complete, demonstrated bypass** (ALLOW where DENY is required, with a test) outranks any hypothesis. Mark robustness
  bugs, hardening suggestions and dependency advisories as such, and group findings with the same root cause.
- Patches should fail closed: do not "fix" a bypass by adding a new allow path, do not weaken or delete an existing check or
  test, and keep the engine and the PostgreSQL RLS functions consistent. Add a regression test, including a concurrent test
  when the invariant is enforced in the database.
- If a fix changes the HTTP API, the OpenAPI document, `guides/server-api.md` and `packages/client/src/generated.ts` are
  generated by `UPDATE_DOCS=1 pnpm --filter @uniora/server test`; regenerate rather than editing them by hand.

## Anything to leave alone

- The Owner passing every permission by design (it is an explicit, documented property), and `<Can>` / `<Feature>`
  being client-side only.
- Behaviour documented in `guides/hardening.md` as an operator responsibility: database roles, branch protection, npm
  settings, and exposing Studio to the internet.
- Missing rate limits or TLS on a server that the operator has chosen to run unprotected on loopback during local use.
- Style, typing and lint issues, and anything only reachable by someone who already controls the database or the host.
