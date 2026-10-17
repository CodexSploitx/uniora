# Contributing to UNIORA

Issues and pull requests are welcome. This is early-stage software: open a discussion first for anything beyond a small fix.

## Setup

Requires Node.js 22+, [pnpm](https://pnpm.io) and Docker (for a local PostgreSQL).

```bash
pnpm install
docker compose up -d                 # Postgres on localhost:55432
cp .env.example .env                 # set DATABASE_URL / TEST_DATABASE_URL if you changed the defaults

pnpm build                           # packages consume each other through dist/, so build first
pnpm typecheck
pnpm test                            # real PostgreSQL and SQLite integration tests, never mocks
pnpm lint                            # Studio's ESLint
```

## Ground rules

- **Security first.** Authorization defaults to deny. A change to the engine, Owner protection, invitations or the audit log needs a test that fails without it.
- **Storage adapters share one suite.** Behaviour that touches storage goes in `packages/database/conformance`, so PostgreSQL and SQLite are held to the same assertions.
- **Migrations are additive and never edited after release.** Add a new numbered migration for both adapters.
- **User-facing text in Studio is translated** (`apps/studio/src/i18n/messages`): add the English key and its Spanish pair; a test checks they match.
- **Keep the APIs up to date, always.** Any change, update or new function must update the UNIORA APIs that expose it: the HTTP API of `@uniora/server` (routes, schemas, scopes, errors, events), `guides/openapi.json`, `guides/server-api.md`, the generated `@uniora/client` surface and the embedded API (`@uniora/core` exports and docs). Regenerate with `UPDATE_DOCS=1 pnpm --filter @uniora/server test`. It also means **documenting how to use it**: what it is for, the requirements (scope, organizations, migration), a minimal working example for each way of using UNIORA (embedded and external server), the rules that surprise, the errors and how to adopt it, in the area guide, `guides/server.md`, the READMEs of the affected packages and, if it is a headline capability, `README.md` and `README.es.md`; hand-written examples are checked. Only a purely internal change is exempt, and the PR says why. The checklist is the project skill `.claude/skills/uniora-api-sync`.
- Releases are lockstep (every package shares one version) and published by a maintainer from a `vX.Y.Z` tag on `main`. Add an entry to `CHANGELOG.md` under `## Unreleased` for user-visible changes; **do not bump versions in a pull request**, the maintainer does it when cutting a release.
- Versions follow [SemVer](https://semver.org): bug fixes only → patch (`0.12.0` → `0.12.1`); new backward-compatible features (a new field, route, scope, error, export or migration) → minor (`0.12.1` → `0.13.0`, patch back to `0`); breaking changes → major (while `0.x`, minor, announced as breaking). A patch never adds or removes public surface.

## Pull requests

Describe what a reader would see before and after, and how you verified it. CI must be green (typecheck, build, tests on Node 22 and 24, dependency audit, package tarballs).
