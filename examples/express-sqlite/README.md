# Express + SQLite example

A small API that uses UNIORA end to end, in one readable file ([`src/app.js`](src/app.js)):

- an organization created with its protected Owner,
- route guards (`requirePermission`) that answer 401/403 and fail closed,
- a permission catalog and `ownerRequiresRegisteredPermission`,
- roles and an invitation flow (`invite`, public preview and accept pages) over SQLite.

```bash
pnpm install
pnpm --filter @uniora/example-express-sqlite test    # runs the whole flow against an in-memory database
pnpm --filter @uniora/example-express-sqlite start   # http://127.0.0.1:3000, data in ./example.db
```

Authentication is faked with the `x-demo-user` / `x-demo-email` headers so the example has no external
dependency. In a real app, resolve the identity with an adapter (`@uniora/supabase`, `@uniora/clerk`,
`@uniora/auth0`, `@uniora/better-auth`) and take `verifiedEmail` from its `toVerifiedEmail()`.

To e-mail invitations, pass `sender: createSmtpInvitationSenderFromEnv()` from `@uniora/mailer-smtp`.
