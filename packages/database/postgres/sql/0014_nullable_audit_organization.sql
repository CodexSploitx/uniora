-- @uniora/postgres migration 0014_nullable_audit_organization
-- Generated from src/migrations/0014_nullable_audit_organization.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Allows a GLOBAL audit log entry — one with no single organization to scope
-- it to (docs/security-pentest-2026-09-24.md Hallazgo 5). Until now every
-- `uniora.audit_logs` row was forced into exactly one organization, but
-- `IdentityLinkRepository.link()` isn't organization-scoped at all: the
-- identities it merges can each hold memberships in any number of different
-- organizations. `organization_id` stays a real foreign key (a `NULL` value
-- always satisfies a foreign key constraint in Postgres, so nothing about
-- the FK itself needs to change) — only the `not null` is dropped.
-- `listByOrganization` is unaffected (its `where organization_id = $1` never
-- matches a `NULL` row, which is exactly the desired behavior: a global
-- entry never appears inside one organization's log); `listRecent` already
-- has no organization filter, so it starts surfacing these too.

alter table uniora.audit_logs alter column organization_id drop not null;
