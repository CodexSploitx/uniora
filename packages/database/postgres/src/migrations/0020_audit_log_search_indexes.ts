/**
 * Indexes for `AuditLogRepository.search`: filtering by action, by actor and by target, newest first, with the same
 * `(created_at, id)` keyset order as `listRecent`. Index-only: no data is read or altered (and the append-only
 * protections of 0017 are untouched).
 */
export const MIGRATION_0020_AUDIT_LOG_SEARCH_INDEXES = `
create index if not exists audit_logs_action_idx on uniora.audit_logs (action, created_at desc, id desc);
create index if not exists audit_logs_actor_idx on uniora.audit_logs (actor_provider, actor_subject, created_at desc, id desc);
create index if not exists audit_logs_target_idx on uniora.audit_logs (target_type, target_id, created_at desc, id desc)
  where target_type is not null;
`;
