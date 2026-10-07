-- @uniora/postgres migration 0015_identity_links_to_index
-- Generated from src/migrations/0015_identity_links_to_index.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Supports the fix for docs/security-pentest-2026-09-24.md Hallazgo 9
-- (Ronda 4): `IdentityLinkRepository.link()` runs its "no chains" checks
-- inside a SERIALIZABLE transaction (see `repositories/identity-link.ts`).
-- Without an index on `(to_provider, to_subject)`, the check that reads by
-- `to_*` (`where to_provider = $1 and to_subject = $2`) has to sequential
-- scan the whole table — Postgres's serializable snapshot isolation (SSI)
-- then has to predicate-lock the ENTIRE table for that read, not just the
-- rows it actually cares about, causing completely UNRELATED concurrent
-- `link()` calls (no shared identity at all) to spuriously conflict with
-- each other. Confirmed empirically: without this index, two independent
-- `link()` pairs racing at the same time saw one of them fail with Postgres
-- `40001` (serialization_failure) even though neither shared an identity;
-- with the index, only genuinely conflicting pairs (sharing an identity)
-- do. Index-only change: no data is read or altered.

create index if not exists identity_links_to_idx
  on uniora.identity_links (to_provider, to_subject);
