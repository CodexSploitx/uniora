<div align="center">

# UNIORA

**Universal Organization & Authorization**

Organizations, teams, roles, permissions and feature flags — for any auth provider, on your own database.

[![GitHub stars](https://img.shields.io/github/stars/CodexSploitx/uniora?style=social)](https://github.com/CodexSploitx/uniora)
![status](https://img.shields.io/badge/status-early%20development-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![pnpm](https://img.shields.io/badge/monorepo-pnpm%20workspaces-yellow)

[Español](README.es.md)

</div>

---

Your auth provider answers **"who is this user?"**. It shouldn't have to also answer **"what organization are they in, and what can they do there?"** — that's a different problem, and one you'll want to own regardless of which auth provider you pick, or move to next year.

**UNIORA is the layer that sits between the two.** It's not an auth provider — it plugs into the one you already use (Supabase, Clerk, Auth0, Better Auth) — and it's not a SaaS: the organizations, memberships, roles, permissions and audit logs it manages live in **your own database**, not ours.

```text
Auth Provider                    UNIORA
     │                              │
"Who are you?"          "What organization? What can you do?
                          What does your organization have enabled?"
     │                              │
     └──────────────┬───────────────┘
                     ▼
               ALLOW / DENY
```

## Why

- **Provider-agnostic.** Swap Supabase for Clerk, or add Auth0 alongside it, without rewriting your authorization logic. `IdentityLinkRepository` even lets a user migrate providers without losing their org, roles or permissions.
- **Your database, your rules.** No central UNIORA service holds your data. Everything lives in Postgres, under a dedicated `uniora.*` schema that won't collide with your app's own tables.
- **Deny-by-default.** The `AuthorizationEngine` never grants access it can't confidently justify — unknown permission, missing membership, wrong organization: always `DENY`, never a silent fallback to `ALLOW`.
- **Organizations can't be orphaned.** Every organization is born with a protected Owner, and `MembershipRepository` refuses to unassign the Owner role or delete a membership if it's the last one holding it — enforced with a real database constraint, not just application code.
- **Organizations *and* entitlements.** Permissions answer "what can this user do"; features answer "what has this organization unlocked." Two different questions, modeled separately, so you don't have to fake one with the other.
- **Framework-independent core.** `@uniora/core` has zero dependency on Next.js, Express, or any specific database driver — adapters plug in around it.

## Quick look

```ts
import { createAuthorizationEngine, createMemoryStorage } from "@uniora/core";
// swap createMemoryStorage() for @uniora/postgres in production

const storage = createMemoryStorage();
const uniora = createAuthorizationEngine(storage);

const canDeleteVehicle = await uniora.can({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "vehicles.delete",
});

// Combined permission + feature-entitlement check
const canUseAI = await uniora.access.check({
  identity: { provider: "supabase", subject: userId },
  organizationId: orgId,
  permission: "assistant.use",
  feature: "ai_assistant",
});
```

Every organization is born with exactly one protected **Owner** — created atomically alongside the organization, never as an afterthought:

```ts
import { createOrganizationWithOwner } from "@uniora/core";

const { organization, membership } = await createOrganizationWithOwner(storage, {
  organizationId: orgId,
  organizationName: "Acme Motors",
  // organizationSlug is optional — derived from the name when omitted
  // ("Acme Motors" -> "acme-motors"), validated and enforced unique either way.
  ownerRoleId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  ownerIdentity: { provider: "supabase", subject: userId },
});
// membership's owner now passes every uniora.can(...) check for this organization,
// regardless of permissionKeys — see @uniora/core's docs for why.
```

Resolving `identity` from a real session is one call to the matching adapter:

```ts
import { resolveIdentity } from "@uniora/supabase"; // or @uniora/clerk, @uniora/auth0, @uniora/better-auth

const identity = await resolveIdentity(supabaseClient, accessToken); // Identity | null
```

Identity adapters only ever answer "who is this?" — never "what can they do?". That decision always belongs to the `AuthorizationEngine`.

Server computes a bounded `AuthorizationSnapshot`, client UI just reads it — `@uniora/react` never talks to your database:

```ts
// server (e.g. a Server Component, an API route)
import { computeAuthorizationSnapshot } from "@uniora/core";

const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
  identity,
  organizationId,
  permissions: ["vehicles.create"],
  features: ["advanced_reports"],
});
```

```tsx
// client
import { UnioraProvider, Can, Feature } from "@uniora/react";

<UnioraProvider snapshot={snapshot}>
  <Can permission="vehicles.create">
    <CreateVehicleButton />
  </Can>
  <Feature feature="advanced_reports">
    <AdvancedReportsPanel />
  </Feature>
</UnioraProvider>
```

`<Can>`/`<Feature>`/`useCan`/`useFeature` are UX only and deliberately headless (no design system baked in) — hiding a button is never a substitute for the server independently authorizing the real operation. See `apps/playground` for a full working example built on shadcn/ui + ReUI.

For Next.js specifically, `@uniora/next` wires the pieces above into the App Router's own patterns — no hard dependency on the `next` package itself, just `react.cache()` for request-scoped memoization and the standard `Response`/`Request` APIs:

```ts
// server — Server Action or Route Handler
import { assertCan, authorizeRoute } from "@uniora/next";

// throws AuthorizationDeniedError — for a Server Action
await assertCan(engine, { identity, organizationId, permission: "vehicles.delete" });

// returns a ready-to-return Response | null — for a Route Handler
const denied = await authorizeRoute(engine, { identity, organizationId, permission: "vehicles.delete" });
if (denied) return denied;
```

## Packages

| Package | What it does |
| --- | --- |
| [`@uniora/core`](packages/core) | Framework-independent domain model: Organizations (with a protected Owner role, created atomically), Custom Roles, Permissions, Features, Audit Logs, cross-provider Identity Linking, and the deny-by-default `AuthorizationEngine`. |
| [`@uniora/postgres`](packages/database/postgres) | PostgreSQL storage adapter (dedicated `uniora.*` schema) + migrations. |
| [`@uniora/supabase`](packages/adapters/supabase) | Identity adapter for Supabase Auth. |
| [`@uniora/clerk`](packages/adapters/clerk) | Identity adapter for Clerk. |
| [`@uniora/better-auth`](packages/adapters/better-auth) | Identity adapter for Better Auth. |
| [`@uniora/auth0`](packages/adapters/auth0) | Identity adapter for Auth0. |
| [`@uniora/react`](packages/react) | Headless React helpers (`<Can>`, `<Feature>`, `useCan`, `useFeature`) over a server-computed `AuthorizationSnapshot`. |
| [`@uniora/next`](packages/next) | Next.js glue: request-scoped memoization (`react.cache()`) plus `assertCan`/`assertAccess`/`authorizeRoute` guards for Server Actions and Route Handlers. |
| [`@uniora/cli`](packages/cli) | `npx uniora init / check / migrate / doctor / studio` — with a migration ledger, `--json` output and CI-friendly exit codes. |
| [`@uniora/studio`](apps/studio) | UNIORA Studio: a local-first admin UI (Next.js + shadcn/ui + ReUI) to browse and manage organizations, members, roles, permissions, features and the audit log. Launched with `npx uniora studio`. |

## Getting started

Requires Node.js, [pnpm](https://pnpm.io), and Docker (for a local Postgres).

```bash
git clone https://github.com/CodexSploitx/uniora.git
cd uniora
pnpm install

docker compose up -d        # Postgres on localhost:55432
cp .env.example .env        # set DATABASE_URL if you changed the defaults

pnpm build       # build every package
pnpm typecheck   # typecheck the whole monorepo
pnpm test        # run every test suite, including real Postgres integration tests
```

## CLI

Install it in your project (this puts the `uniora` command on your `PATH` for `npx`):

```bash
npm install --save-dev @uniora/cli
```

or run it once without installing anything: `npx @uniora/cli init`. (Use the scoped name for that one-off form — a bare `npx uniora` outside a project that already has `@uniora/cli` installed would resolve to a *different* npm package.)

```bash
npx uniora init      # scaffold uniora.config.mjs + .env.example in your project
npx uniora check     # validate config and the database connection
npx uniora migrate   # apply pending uniora.* migrations (tracked in a ledger, additive, never destructive)
npx uniora doctor    # deeper diagnostics: Node, .gitignore, config, DB, PostgreSQL version, migrations, owners, Studio
npx uniora studio    # open UNIORA Studio locally (--read-only, --port N, --no-open)
```

Built to run in CI as well as on your laptop:

```bash
npx uniora migrate --status --env production   # exits 1 if migrations are pending or were edited after applying
npx uniora migrate --dry-run                   # what would `migrate` do? touches nothing
npx uniora doctor --json | jq '.checks[] | select(.severity != "ok")'
```

Every command accepts `--config <file>`, `--env <name>` (loads `.env.<name>` — and only that, never silently falling back to your dev `.env`) and `--json` (a single JSON object on stdout, never containing your connection string). Exit codes: `0` ok · `1` something failed · `2` bad usage. `npx uniora <command> --help` for details.

**UNIORA Studio** is a local admin UI over your own database — a roles-and-permissions editor, members, per-organization features, a global permission/feature catalog and an append-only activity log. It only listens on `127.0.0.1`, is unlocked by a random per-launch token, and never sends data anywhere. Every change it makes is audited; `--read-only` turns it into a safe viewer.

## Design principles

- **Server-side authorization is the only real authorization.** Client components (`<Can>`, `<Feature>`) are UX sugar, never a security boundary.
- **Explicit over implicit.** Every organization-scoped operation verifies real membership — `userId + organizationId` is never treated as sufficient on its own.
- **No hard dependency on third-party SDKs.** Identity adapters define a minimal structural contract; your app supplies the real, already-configured client.
- **Additive migrations.** Nothing UNIORA runs against your database is destructive by default.

## Status

UNIORA is under active development (V1.x). Published on npm under the [`@uniora`](https://www.npmjs.com/org/uniora) scope (`0.x`: the API may still change between minor versions).

## Contributing

Issues and pull requests are welcome — this is early-stage, so open a discussion first for anything beyond a small fix.

## License

UNIORA is **source-available** under the [PolyForm Shield License 1.0.0](LICENSE) — free to use, but it can't be sold.

- **You can** use it, for free, in any project — personal, internal or commercial, including a paid SaaS or product that *depends on* UNIORA — and read, modify and redistribute it (keeping the license and the `Required Notice` line).
- **You can't** use it to provide a product that competes with UNIORA — for example reselling it, repackaging it, or offering it (or a substitute for it) as your own paid or free product or service.

That's a plain-language summary; the [`LICENSE`](LICENSE) file is the only thing that governs. Note this is not an OSI-approved "open source" license.
