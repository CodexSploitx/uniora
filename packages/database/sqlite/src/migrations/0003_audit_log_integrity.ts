/**
 * Tamper resistance for the audit log (audit F-04).
 *
 * - `UPDATE` and `DELETE` of an audit row abort, whoever issues them. (A
 *   writer with raw access to the file can still drop the triggers — that is
 *   what the hash chain is for.)
 * - `prev_hash`/`hash` chain each entry to the one before it; the repository
 *   fills them in `record()` and `verifyIntegrity()` recomputes them. Rows
 *   written before this migration have no hash and are reported as unchained
 *   rather than guessed at.
 */
export const AUDIT_APPEND_ONLY_TRIGGERS = `
create trigger if not exists uniora_audit_logs_no_update before update on uniora_audit_logs
begin
  select raise(abort, 'uniora_audit_logs is append-only: UPDATE is not allowed');
end;
create trigger if not exists uniora_audit_logs_no_delete before delete on uniora_audit_logs
begin
  select raise(abort, 'uniora_audit_logs is append-only: DELETE is not allowed');
end;
`;

export const MIGRATION_0003_AUDIT_LOG_INTEGRITY = `
alter table uniora_audit_logs add column prev_hash text;
alter table uniora_audit_logs add column hash text;
${AUDIT_APPEND_ONLY_TRIGGERS}
`;
