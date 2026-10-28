# @uniora/cli

The `uniora` command for [UNIORA](https://github.com/CodexSploitx/uniora): scaffold a config, validate it, apply migrations, diagnose a project and open Studio.

```bash
npm install --save-dev @uniora/cli      # or run once: npx @uniora/cli init
```

```bash
npx uniora init      # uniora.config.mjs + .env.example (--provider sqlite for SQLite)
npx uniora check     # validate config and the database connection
npx uniora migrate   # apply pending migrations (--status and --dry-run touch nothing)
npx uniora platform init --admin provider:subject   # first Platform Administrator (once; see guides/platform.md)
npx uniora server clients create --name backend --scopes check --orgs '*'   # API clients and keys of the server (guides/server.md)
npx uniora server start   # run the API server (tokens, platform, webhooks: the `server` section of uniora.config.mjs)
npx uniora webhooks create --url https://hooks.example.com/uniora --events 'membership.*'   # signed webhooks (guides/server.md)
npx uniora doctor    # Node, .gitignore, config, database, migrations, owners, RLS bypass, audit chain, SMTP, Studio
npx uniora studio    # local admin UI (--read-only, --port N, --no-open)
```

Every command accepts `--config <file>`, `--env <name>` and `--json` (one JSON object on stdout, never your connection string). Exit codes: `0` ok, `1` failed, `2` bad usage.

On PostgreSQL, `uniora doctor` warns (read-only, catalog only) when the role it connects with would skip your row-level security policies: it owns tables that have RLS but not `FORCE ROW LEVEL SECURITY`, or it is a superuser / has `BYPASSRLS`. Run it with the application's `DATABASE_URL` to check the role that matters; see [RLS §4](https://github.com/CodexSploitx/uniora/blob/main/guides/rls.md#4-the-table-owner-skips-the-policies). `uniora migrate` needs a role with `CREATE` on the database ([Storage](https://github.com/CodexSploitx/uniora/blob/main/guides/storage.md#postgresql)).

`uniora doctor` also checks your `UNIORA_SMTP_*` settings when `@uniora/mailer-smtp` is installed (it validates them; it never connects or prints credentials). Studio reads `UNIORA_INVITE_URL` (for example `https://app.example.com/invite/{token}`) to create invitations.

**Security note:** the CLI loads `uniora.config.mjs` and `.env` from the current directory, like `vite.config`. Don't run it inside a repository you don't trust. It refuses a config or `.env` file that is writable by everyone.

See the [main README](https://github.com/CodexSploitx/uniora#cli) for PostgreSQL and SQLite details. Documentation: [CLI, Studio and configuration guide](https://github.com/CodexSploitx/uniora/blob/main/guides/cli-and-studio.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [Apache-2.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
