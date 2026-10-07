/**
 * Timed suspensions: `blocked_until` is the end of a block that lifts itself.
 *
 * - There is no job and no new status: a membership counts as blocked only while `status = 'blocked'` AND
 *   (`blocked_until` is null OR `blocked_until` is in the future). A row whose date has passed is simply active again
 *   (the library reads it that way everywhere, and so does `uniora.active_membership_id`, redefined here); `unblock`
 *   or a new block clears the leftover columns.
 * - `blocked_until` can only be set while blocked, and must be after `blocked_at`.
 */
export const MIGRATION_0029_MEMBERSHIP_SUSPENSION = `
alter table uniora.memberships add column if not exists blocked_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_blocked_until_consistent') then
    alter table uniora.memberships
      add constraint memberships_blocked_until_consistent
      check (blocked_until is null or (status = 'blocked' and blocked_until > blocked_at));
  end if;
end $$;

create or replace function uniora.active_membership_id(p_org text, p_provider text, p_subject text)
returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select m.id
  from uniora.memberships m
  where m.organization_id = p_org
    and (m.status = 'active' or (m.blocked_until is not null and m.blocked_until <= now()))
    and exists (select 1 from uniora.organizations o where o.id = m.organization_id and o.status = 'active')
    and (
      (m.provider = p_provider and m.subject = p_subject)
      or exists (
        select 1 from uniora.identity_links il
        where il.from_provider = p_provider and il.from_subject = p_subject
          and il.to_provider = m.provider and il.to_subject = m.subject
      )
    )
  limit 1
$$;
`;
