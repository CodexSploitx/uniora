/**
 * Tamper resistance for the audit log (audit F-04).
 *
 * 1. Append-only IN THE DATABASE: any `UPDATE` or `DELETE` of an audit row
 *    raises an error, whoever issues it (the application, a script, a DBA at
 *    a psql prompt). `TRUNCATE` is not blocked — it needs table ownership,
 *    and the application's role should never have it (see docs/hardening.md).
 * 2. A hash chain: a BEFORE INSERT trigger numbers each entry (`seq`) and
 *    stores `hash = sha256(prev_hash || the entry's content)`. The advisory
 *    lock makes numbering and linking one serial step, so concurrent writers
 *    can't fork the chain. Anyone with enough privilege to disable the
 *    triggers and edit a row still can't do it undetected:
 *    `uniora.verify_audit_chain()` recomputes every hash.
 *
 * Existing rows are chained in their `(created_at, id)` order before the
 * protections go on.
 */
export const MIGRATION_0017_AUDIT_LOG_INTEGRITY = `
alter table uniora.audit_logs add column if not exists seq bigint;
alter table uniora.audit_logs add column if not exists prev_hash text;
alter table uniora.audit_logs add column if not exists hash text;
create sequence if not exists uniora.audit_logs_seq;

create or replace function uniora.audit_log_digest(
  p_prev text, p_id text, p_org text, p_provider text, p_subject text, p_action text,
  p_target_type text, p_target_id text, p_metadata jsonb, p_created_at timestamptz
) returns text
language sql immutable as $$
  select encode(
    sha256(convert_to(
      concat_ws(E'\\x1f',
        coalesce(p_prev, ''), p_id, coalesce(p_org, ''), p_provider, p_subject, p_action,
        coalesce(p_target_type, ''), coalesce(p_target_id, ''), coalesce(p_metadata::text, ''),
        to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ), 'UTF8')),
    'hex')
$$;

do $backfill$
declare
  r record;
  prev text := null;
  h text;
  n bigint := 0;
begin
  for r in select * from uniora.audit_logs where seq is null order by created_at, id loop
    n := nextval('uniora.audit_logs_seq');
    h := uniora.audit_log_digest(prev, r.id, r.organization_id, r.actor_provider, r.actor_subject,
           r.action, r.target_type, r.target_id, r.metadata, r.created_at);
    update uniora.audit_logs set seq = n, prev_hash = prev, hash = h where id = r.id;
    prev := h;
  end loop;
end
$backfill$;

create unique index if not exists audit_logs_seq_idx on uniora.audit_logs (seq);

create or replace function uniora.audit_logs_chain() returns trigger
language plpgsql as $$
declare
  prev text;
begin
  perform pg_advisory_xact_lock(7263949163);
  new.created_at := date_trunc('milliseconds', new.created_at);
  select hash into prev from uniora.audit_logs where seq is not null order by seq desc limit 1;
  new.seq := nextval('uniora.audit_logs_seq');
  new.prev_hash := prev;
  new.hash := uniora.audit_log_digest(prev, new.id, new.organization_id, new.actor_provider, new.actor_subject,
                new.action, new.target_type, new.target_id, new.metadata, new.created_at);
  return new;
end
$$;

create or replace function uniora.audit_logs_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'uniora.audit_logs is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists audit_logs_chain on uniora.audit_logs;
create trigger audit_logs_chain before insert on uniora.audit_logs
  for each row execute function uniora.audit_logs_chain();

drop trigger if exists audit_logs_append_only on uniora.audit_logs;
create trigger audit_logs_append_only before update or delete on uniora.audit_logs
  for each row execute function uniora.audit_logs_append_only();

-- Walks the chain and returns the first entry that fails. No rows returned in
-- 'broken_id' means the chain is intact.
create or replace function uniora.verify_audit_chain()
returns table (checked bigint, head_seq bigint, head_hash text, broken_id text, broken_reason text)
language plpgsql stable as $$
declare
  r record;
  prev text := null;
  n bigint := 0;
begin
  for r in select * from uniora.audit_logs where seq is not null order by seq loop
    if r.prev_hash is distinct from prev then
      return query select n, null::bigint, null::text, r.id, 'chain_broken'::text;
      return;
    end if;
    if r.hash is distinct from uniora.audit_log_digest(prev, r.id, r.organization_id, r.actor_provider,
         r.actor_subject, r.action, r.target_type, r.target_id, r.metadata, r.created_at) then
      return query select n, null::bigint, null::text, r.id, 'content_mismatch'::text;
      return;
    end if;
    prev := r.hash;
    n := n + 1;
    head_seq := r.seq;
  end loop;
  return query select n, head_seq, prev, null::text, null::text;
end
$$;
`;
