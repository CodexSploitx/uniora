/**
 * Supports `AuditLogRepository.listRecent` — a global, cross-organization
 * activity feed (e.g. Studio's "all activity" page, docs/studio.md). The
 * existing `(organization_id, created_at desc)` index from migration 0002
 * can't serve a query with no `organization_id` predicate; without an
 * index covering just `(created_at desc, id desc)`, a global "most recent
 * across every organization" query would need a full table scan + sort,
 * which gets slower as `audit_logs` grows (it never shrinks — append-only
 * by design). `id desc` matches the keyset tiebreaker `listRecent` uses
 * for entries that share a millisecond timestamp.
 */
export const MIGRATION_0009_AUDIT_LOGS_RECENT_INDEX = `
create index if not exists audit_logs_created_at_id_idx
  on uniora.audit_logs (created_at desc, id desc);
`;
