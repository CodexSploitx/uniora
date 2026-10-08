# CLI, Studio and configuration

## The `uniora` command

```bash
npm install --save-dev @uniora/cli     # puts `uniora` on npx's path
npx @uniora/cli init                   # one-off, without installing
```

Use the scoped name for the one-off form: a bare `npx uniora` outside a project with `@uniora/cli` installed would run a different npm package.

| Command | What it does |
| --- | --- |
| `uniora init [--provider postgresql\|sqlite] [--force]` | Writes `uniora.config.mjs` and `.env.example`, and adds `.env`, `.env.*.local` (and `uniora.db*` for SQLite) to `.gitignore`. Never overwrites without `--force`. |
| `uniora check` | Validates the configuration and the database connection. |
| `uniora migrate [--status \| --dry-run]` | Applies pending migrations, recorded in a ledger, additive and never destructive. `--status` only reports and **exits 1** if migrations are pending or were edited after being applied (a CI gate); `--dry-run` shows what would run. |
| `uniora doctor` | Deeper diagnosis: Node version, `.gitignore`, config, connection, engine version, migrations, organizations without an Owner, audit-chain integrity, SMTP settings (only when some `UNIORA_SMTP_*` variable is set and `@uniora/mailer-smtp` is installed), Studio availability. |
| `uniora platform init --admin provider:subject` / `uniora platform status` | Creates the first Platform Administrator (once, needs database access) / shows platform members. See [platform](platform.md). |
| `uniora studio [--port N] [--read-only] [--no-open]` | Opens Studio locally. |

Options every command accepts: `--config <file>` (instead of `uniora.config.mjs`), `--env <name>` (loads `.env.<name>`, and **only** that, never silently
falling back to your dev `.env`) and `--json` (one JSON object on stdout, never containing the connection string; not for `studio`).
Exit codes: `0` ok, `1` something failed, `2` wrong usage. `uniora <command> --help` prints the details (the CLI's own messages are in Spanish).

In CI:

```bash
npx uniora migrate --status --env production
npx uniora doctor --json | jq '.checks[] | select(.severity != "ok")'
```

Security: the CLI loads `uniora.config.mjs` and `.env` from the current directory, like `vite.config` does. Don't run it inside a repository you don't trust. It refuses a config or `.env` that is writable by everyone.

### `uniora.config.mjs`

```js
import { defineConfig } from "@uniora/cli";

export default defineConfig({
  database: {
    provider: "postgresql",             // or "sqlite"
    url: process.env.DATABASE_URL,      // postgresql://… or sqlite:./uniora.db (relative to the project, or absolute)
  },
  auth: { provider: "supabase" },       // optional: pre-fills the provider field in Studio forms
});
```

Never hard-code the URL. With SQLite, read-only commands (`check`, `doctor`, `migrate --status`/`--dry-run`) open the file read-only and never create it; only `migrate` creates it (and switches it to WAL).

## Studio

A local admin UI over your own database: organizations (with their members, teams, roles, features and invitations), members, the global permission and feature catalogs and the activity log.

```bash
npx uniora studio            # first free port from 4321
npx uniora studio --read-only
```

- Listens on `127.0.0.1` only, and is unlocked by a random token generated at each launch. It sends data nowhere.
- Every change goes through the audited storage with the operator (the OS user that launched it, or `UNIORA_STUDIO_OPERATOR`) as the actor.
- `--read-only` makes Studio refuse every change, and with SQLite the connection itself is read-only.
- It works on PostgreSQL and SQLite and shows which engine it is using. If the tables don't exist it tells you to run `uniora migrate`.
- It is an operator tool: run it on your machine or behind your own access control, never exposed to the internet.

Studio is launched by the CLI; it isn't meant to be started directly.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | CLI, Studio (through the config) | Connection string: `postgresql://…` or `sqlite:<path>`. The generated config reads it. |
| `UNIORA_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASS`, `_FROM`, `_REPLY_TO`, `_REQUIRE_TLS`, `_TLS_REJECT_UNAUTHORIZED` | `@uniora/mailer-smtp`, `doctor`, Studio | See [Invitations](invitations.md#sending-e-mail-with-smtp). |
| `UNIORA_INVITE_URL` | Studio | Page of your app that accepts invitations, with `{token}` in the path or fragment. Required to invite from Studio. |
| `UNIORA_STUDIO_OPERATOR` | Studio | Name recorded as the actor of Studio's changes. Defaults to the OS user. |
| `TEST_DATABASE_URL` | the repository's own tests | A **different** database from `DATABASE_URL`: tests truncate its tables. |

`UNIORA_STUDIO_DATABASE_URL`, `_DATABASE_PROVIDER`, `_TOKEN`, `_PORT`, `_READ_ONLY` and `_AUTH_PROVIDER` are set by the CLI for Studio. Don't set them yourself.

Keep `.env` out of git. `uniora init` and `uniora doctor` check that it is ignored.
