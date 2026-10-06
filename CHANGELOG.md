# Changelog

All notable changes to UNIORA. Packages are released in lockstep, so one version number covers all of them. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added

- **Audit log you can query**: `auditLogs.search({ organizationId?, action?, actionPrefix?, actor?, target?, since?, until?, limit?, before? })` (filters combine, newest first, keyset cursor; indexes in Postgres `0020` / SQLite `0006`), the catalog of standard action names (`AUDIT_ACTIONS`, `isStandardAuditAction`) and a mandatory actor: an entry with an empty actor or action is rejected (`audit_actor_required`, `audit_action_invalid`) in every backend. `createAuditedStorage` is covered by a test that fails if a repository gains a mutating method it doesn't audit.
- **Profiles for members**: an optional `ProfileResolver` the host implements (`resolveProfiles(identities)` against its own users table or provider) and `listMembersWithProfiles(storage, resolver, options)`, which adds a `profile { displayName, email, avatarUrl }` to each listed member with ONE resolver call per page. Output is sanitised (capped strings, `http(s)` avatars only), a failing resolver never breaks the listing, and UNIORA still depends on no provider.
- **Blockable memberships**: `Membership.status` (`active` | `blocked`) with `block(id, { actor, reason })`, `unblock` and `recordActivity`. A blocked member keeps their roles but `can()`, `access.check()` and snapshots deny everything; the last active Owner can't be blocked; listings and counts filter by status. Memberships also carry `createdAt`, `updatedAt`, `invitedBy` (filled when they come from an invitation) and `lastActiveAt`. Postgres migration `0019`, SQLite `0005`; memberships that predate it get the migration time as `createdAt`.
- **Features on by default, parent/child features, bulk changes**: `FeatureDefinition.defaultEnabled` (a new feature is born active, no rows to backfill) and `parentKey` (turning a parent off turns its children off); `isEnabled`, `access.check`, snapshots and usage counts use the effective state. New `listEffective(org)` (with the reason: `enabled`, `disabled`, `default`, `parent_disabled`), `setMany` (atomic), `disableEverywhere` (kill switch) and `updatedAt` / `updatedBy` / `reason` on every override. Postgres migration `0018`, SQLite `0004`. **Breaking (0.x):** `register()` is a full upsert, so re-registering without `defaultEnabled` / `parentKey` resets them.
- **Stable error codes**: every error UNIORA throws on purpose extends `UnioraError` and carries a `code` (`membership_not_found`, `last_owner`, `feature_unknown`, `role_key_exists`, `invitation_expired`, …) so an application can translate or branch without comparing the English message. Codes are only ever added, never renamed.
- **Invitations in Studio**: an *Invitations* tab per organization to invite, send again and revoke, with the delivery status and the link shown once (`UNIORA_INVITE_URL`; e-mail through `@uniora/mailer-smtp` when `UNIORA_SMTP_*` is set).
- **Accept routes for invitations**: `invitationPreview` / `acceptInvitation` in `@uniora/express` and `previewInvitationRoute` / `acceptInvitationRoute` in `@uniora/next`, backed by `invitationErrorToHttp` in `@uniora/core` (one generic `400` for every way an accept can fail).
- `transferOwnership` and `leaveOrganization` in `@uniora/core`: atomic, audited, and the last Owner can never leave.
- `uniora doctor` validates `UNIORA_SMTP_*` (never connects, never prints credentials).
- `examples/express-sqlite`: a runnable app with tests, and a README for every package.
- `SECURITY.md`, `CONTRIBUTING.md`, `guides/hardening.md` and `guides/roadmap.md`.

### Fixed

- `docs/` was git-ignored, so the hardening guide linked from the README never shipped. It now lives in `guides/` (with the least-privilege SQL roles).
- npm descriptions no longer point at a private local file.

## 0.2.0

- SQLite storage adapter, CLI and Studio support for SQLite.
- `@uniora/express` route guards, organization renaming in Studio, invitations with `@uniora/mailer-smtp`.
- Security hardening from the audit: append-only hash-chained audit log, fail-closed guards, Owner protection options, least-privilege roles, supply-chain controls in CI.
