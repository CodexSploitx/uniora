-- @uniora/sqlite migration 0007_audit_log_retention
-- Generated from src/migrations/0007_audit_log_retention.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Audit retention (audit F-04 follow-up). `uniora_audit_log_checkpoints` records, for every prune, the last removed
-- entry; the chain is verified from the newest checkpoint's hash. Append-only like the log itself. Only
-- `AuditLogRepository.pruneBefore` removes audit rows: it drops the `no_delete` trigger and puts it back INSIDE one
-- `begin immediate` transaction, so no other connection ever sees the table unprotected (and a failure rolls the
-- trigger back with everything else).

create table if not exists uniora_audit_log_checkpoints (
  id integer primary key autoincrement,
  through_seq integer not null,
  through_hash text not null,
  removed integer not null check (removed > 0),
  cutoff text not null,
  created_at text not null
);

create trigger if not exists uniora_audit_log_checkpoints_no_update before update on uniora_audit_log_checkpoints
begin
  select raise(abort, 'uniora_audit_log_checkpoints is append-only: UPDATE is not allowed');
end;
create trigger if not exists uniora_audit_log_checkpoints_no_delete before delete on uniora_audit_log_checkpoints
begin
  select raise(abort, 'uniora_audit_log_checkpoints is append-only: DELETE is not allowed');
end;
