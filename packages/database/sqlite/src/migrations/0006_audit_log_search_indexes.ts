/**
 * Indexes for `AuditLogRepository.search` (same as `@uniora/postgres`'s `0020`): by action, actor and target, newest first.
 * Index-only; the append-only triggers are untouched.
 */
export const MIGRATION_0006_AUDIT_LOG_SEARCH_INDEXES = `
create index if not exists uniora_audit_logs_action_idx on uniora_audit_logs (action, created_at desc, id desc);
create index if not exists uniora_audit_logs_actor_idx on uniora_audit_logs (actor_provider, actor_subject, created_at desc, id desc);
create index if not exists uniora_audit_logs_target_idx on uniora_audit_logs (target_type, target_id, created_at desc, id desc)
  where target_type is not null;
`;
