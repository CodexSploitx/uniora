-- @uniora/postgres migration 0022_audit_log_retention
-- Generated from src/migrations/0022_audit_log_retention.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Audit retention (audit F-04 follow-up): a way to drop OLD audit entries without giving up tamper evidence.
--
-- - `uniora.audit_log_checkpoints` records, for every prune, the last removed entry (`through_seq`, `through_hash`).
--   It is append-only like the log itself. The chain is verified starting from the newest checkpoint's hash, so an
--   entry edited or deleted after it is still detected.
-- - `uniora.prune_audit_logs(...)` is the ONLY door for removing rows. It is `security definer` with a pinned
--   `search_path`, EXECUTE is revoked from `public` (grant it to the retention role only), it never removes the newest
--   entry (the chain stays continuous) and it records an `audit_log.pruned` entry in the same transaction.
-- - The append-only trigger now lets a DELETE through only while that function runs: a transaction-local flag AND the
--   session being the table owner. A role that merely sets the flag (the application) is still rejected.

create table if not exists uniora.audit_log_checkpoints (
  id bigint generated always as identity primary key,
  through_seq bigint not null,
  through_hash text not null,
  removed bigint not null check (removed > 0),
  cutoff timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_checkpoints_through_idx on uniora.audit_log_checkpoints (through_seq desc);

create or replace function uniora.audit_logs_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Only the retention function deletes, and only as the table owner (a role that sets the flag by hand is not).
  if tg_op = 'DELETE'
     and tg_table_name = 'audit_logs'
     and pg_catalog.current_setting('uniora.audit_pruning', true) = 'on'
     and current_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = tg_relid) then
    return old;
  end if;
  raise exception '% is append-only: % is not allowed', tg_table_schema || '.' || tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists audit_log_checkpoints_append_only on uniora.audit_log_checkpoints;
create trigger audit_log_checkpoints_append_only before update or delete on uniora.audit_log_checkpoints
  for each row execute function uniora.audit_logs_append_only();

-- Same walk as before, but starting from the newest checkpoint's hash when entries were pruned.
create or replace function uniora.verify_audit_chain()
returns table (checked bigint, head_seq bigint, head_hash text, broken_id text, broken_reason text)
language plpgsql stable
set search_path = pg_catalog, pg_temp
as $$
declare
  r record;
  prev text := null;
  n bigint := 0;
begin
  select c.through_hash into prev from uniora.audit_log_checkpoints c order by c.through_seq desc limit 1;
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

-- Removes the entries older than p_before (a contiguous prefix; never the newest entry), writes the checkpoint and
-- the 'audit_log.pruned' entry, all in the caller's transaction. Returns what was removed.
create or replace function uniora.prune_audit_logs(
  p_before timestamptz, p_actor_provider text, p_actor_subject text, p_entry_id text
) returns table (removed bigint, through_seq bigint, through_hash text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  head bigint;
  first_kept bigint;
  limit_seq bigint;
  cp_seq bigint;
  cp_hash text;
  n bigint;
begin
  if p_before is null or p_before > pg_catalog.now() then
    raise exception 'The retention cut-off must be a valid date in the past.' using errcode = '22023';
  end if;
  if p_actor_provider is null or p_actor_provider = '' or p_actor_subject is null or p_actor_subject = '' then
    raise exception 'Pruning the audit log needs an actor.' using errcode = '22023';
  end if;

  -- Same lock as the chain trigger: nothing is appended while the prefix is being cut.
  perform pg_catalog.pg_advisory_xact_lock(7263949163);

  select max(l.seq) into head from uniora.audit_logs l;
  if head is null then
    return query select 0::bigint, null::bigint, null::text;
    return;
  end if;
  select min(l.seq) into first_kept from uniora.audit_logs l where l.created_at >= p_before;
  limit_seq := least(coalesce(first_kept, head), head);

  select l.seq, l.hash into cp_seq, cp_hash from uniora.audit_logs l where l.seq < limit_seq order by l.seq desc limit 1;
  if cp_seq is null then
    return query select 0::bigint, null::bigint, null::text;
    return;
  end if;

  perform pg_catalog.set_config('uniora.audit_pruning', 'on', true);
  delete from uniora.audit_logs l where l.seq < limit_seq;
  get diagnostics n = row_count;
  perform pg_catalog.set_config('uniora.audit_pruning', 'off', true);

  insert into uniora.audit_log_checkpoints (through_seq, through_hash, removed, cutoff)
    values (cp_seq, cp_hash, n, p_before);
  insert into uniora.audit_logs (id, actor_provider, actor_subject, action, metadata)
    values (p_entry_id, p_actor_provider, p_actor_subject, 'audit_log.pruned',
            pg_catalog.jsonb_build_object('before', p_before, 'removed', n, 'throughPosition', cp_seq));

  return query select n, cp_seq, cp_hash;
end
$$;

revoke all on function uniora.prune_audit_logs(timestamptz, text, text, text) from public;
