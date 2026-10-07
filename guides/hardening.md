# Hardening guide

UNIORA's code enforces authorization, but some controls live in your database, your deployment and your
repository settings. This guide lists them. Everything here is optional, and everything here is recommended
for production.

## 1. Authorize at the boundary, on the server

- `<Can>` and `<Feature>` (React) are UX only. Every route that changes data must call the engine
  (`can`, `access.check`) or use `requirePermission` / `authorize` (`@uniora/express`) or `authorizeRoute` /
  `assertAccess` (`@uniora/next`).
- A dynamic permission that resolves to `undefined` or `""` is **denied** by the Express middleware. Keep it
  that way: don't wrap it in a fallback that returns a default permission.
- Pass a real organization id from the route, never from the request body.

## 2. The Owner role

- The Owner passes every permission unconditionally, so a typo in a permission key is also "allowed" for the
  Owner. Create the engine with `ownerRequiresRegisteredPermission: true` so the Owner only passes keys that
  are registered in the permission catalog (`storage.permissions.register`).
- Malformed keys (empty, non-string, wrong shape) are always denied, even for the Owner.
- The Owner role can't be granted by `assignRole` or by an invitation. Use `assignOwnerRole`, and authorize it
  with a stricter permission than ordinary role changes (for example `organization.transfer_ownership`).

## 3. Invitations

- UNIORA does **not** decide who may invite. Guard `invite`, `resend` and `revoke` with your own permission
  (we suggest `members.invite`), for example with `requirePermission(engine, "members.invite", …)`.
- `verifiedEmail` in `accept` must come from your auth provider's *verified* e-mail, never from a form field.
  Each adapter exposes `toVerifiedEmail()` for this; use it.
- Put the invitation token in the URL path or fragment, never in a query string that your proxy or analytics
  would log.
- Set `UNIORA_SMTP_REQUIRE_TLS=true` (the default) and keep `UNIORA_SMTP_TLS_REJECT_UNAUTHORIZED=true`.
  `npx uniora doctor` reports an invalid or missing SMTP configuration.

## 4. Audit log

- The audit log is append-only and hash-chained in Postgres, SQLite and memory. `npx uniora doctor` verifies the
  chain, and `auditLogs.verifyIntegrity()` does the same from code.
- Retention: keep the trail as long as your obligations say (CLIMASY-style five years, for example) and drop only what is older, with
  `applyAuditRetention(storage, { keep: { years: 5 }, actor })` from a scheduled job. It never removes the newest entry, records a
  checkpoint so the chain still verifies, and writes an `audit_log.pruned` entry. Export what you must keep (`auditLogs.search`) BEFORE
  it runs, and re-take your external anchor (`verifyIntegrity().head`) afterwards: an anchor older than the checkpoint can no longer be
  checked and reads `anchor: "pruned"`. In Postgres the pruning function is `revoked from public`: grant it to the role of the retention
  job only (`grant execute on function uniora.prune_audit_logs(timestamptz, text, text, text) to uniora_retention;`), never to `uniora_app`.
- A chain alone can't detect that the *newest* entries were deleted. Periodically export the head
  (`verifyIntegrity()` returns it as `head: { position, hash }`) to somewhere the database admin can't
  rewrite (a write-once bucket, another system) and verify it later with
  `verifyIntegrity({ anchor: { position, hash } })`. The result is `valid`, `missing` (truncated) or
  `mismatch` (history changed).
- Wrap your storage with `createAuditedStorage(storage, { actor })` to record every change made through
  the repositories in the same transaction as the change.
- Pass `onDecision` to the engine to keep a forensic trail of allow and deny decisions. A failing hook never
  changes a decision.

## 5. Database roles (PostgreSQL)

Use two roles so the credentials your running app holds can't alter the schema or touch the audit trail:

- `uniora_migrator` owns the schema and runs `uniora migrate` from CI/CD or an operator's shell, never from the
  application environment.
- `uniora_app` is what the application, Studio and the SDK connect as: data access only, read and append on
  `audit_logs`.

[`guides/sql/least-privilege-roles.sql`](sql/least-privilege-roles.sql) creates both. Run it once as a
superuser and re-run its `grant` section after every upgrade that adds tables. Validated on PostgreSQL 16:
with `uniora_app`, `UPDATE`, `DELETE` and `TRUNCATE` on `audit_logs`, `DROP` / `ALTER`, removing the trigger and
writing `schema_migrations` all fail with `42501`.

SQLite: the database file is created with private permissions (`0600`). Keep it outside the web root and out of
backups that other people can read.

## 6. The CLI and Studio

- `uniora` loads `uniora.config.mjs` / `.js` and `.env` from the current directory, like `vite.config`. Don't run
  it inside a repository you don't trust. The CLI refuses a config or `.env` file that is writable by everyone.
- Studio is an operator tool. Run it on loopback, behind your own access control, never exposed to the internet.

## 7. Repository and npm settings (not enforceable from code)

Do these in GitHub and npm:

- [ ] **Branch protection on `main`**: require pull requests, the CI checks, and at least one review; block force
      pushes.
- [ ] **Protect `v*` tags** (a tag ruleset) so only maintainers can push the tag that triggers a release.
- [ ] **Required reviewers on the `npm` environment**: every publication needs a human approval.
- [ ] **Trusted publishing**: configure it on npm for each `@uniora/*` package and drop the long-lived
      `NPM_TOKEN` secret. The release workflow already has `id-token: write` for provenance.
- [ ] **CodeQL** (code scanning) and **secret scanning with push protection**.
- [ ] Keep Dependabot enabled (`.github/dependabot.yml`) and watch the `pnpm audit` step in CI.
- [ ] Add a `SECURITY.md` with a private reporting channel.
