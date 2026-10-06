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
- Releases are lockstep (every package shares one version) and published by a maintainer from a `vX.Y.Z` tag. Add an entry to `CHANGELOG.md` for user-visible changes.

## Pull requests

Describe what a reader would see before and after, and how you verified it. CI must be green (typecheck, build, tests on Node 22 and 24, dependency audit, package tarballs).
