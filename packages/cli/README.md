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
npx uniora doctor    # Node, .gitignore, config, database, migrations, owners, audit chain, SMTP, Studio
npx uniora studio    # local admin UI (--read-only, --port N, --no-open)
```

Every command accepts `--config <file>`, `--env <name>` and `--json` (one JSON object on stdout, never your connection string). Exit codes: `0` ok, `1` failed, `2` bad usage.

`uniora doctor` also checks your `UNIORA_SMTP_*` settings when `@uniora/mailer-smtp` is installed (it validates them; it never connects or prints credentials). Studio reads `UNIORA_INVITE_URL` (for example `https://app.example.com/invite/{token}`) to create invitations.

**Security note:** the CLI loads `uniora.config.mjs` and `.env` from the current directory, like `vite.config`. Don't run it inside a repository you don't trust. It refuses a config or `.env` file that is writable by everyone.

See the [main README](https://github.com/CodexSploitx/uniora#cli) for PostgreSQL and SQLite details. Documentation: [CLI, Studio and configuration guide](https://github.com/CodexSploitx/uniora/blob/main/guides/cli-and-studio.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
