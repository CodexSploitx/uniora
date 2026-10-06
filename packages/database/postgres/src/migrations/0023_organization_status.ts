/**
 * Organization status (`active` | `suspended` | `archived`) and who/when/why it last changed.
 *
 * Every existing organization is `active`. The history of changes lives in the audit log (`organization.status_changed`);
 * these columns only keep the CURRENT one. `uniora.active_membership_id` (the single place the RLS functions of
 * `0021_rls_functions` resolve a member) now also requires the organization to be active, so `is_member`,
 * `has_permission` and `has_access` deny everyone in a suspended or archived organization, exactly like the TypeScript
 * engine. `is_feature_enabled` keeps answering the raw state of the feature, like `features.isEnabled`.
 */
export const MIGRATION_0023_ORGANIZATION_STATUS = `
alter table uniora.organizations add column if not exists status text not null default 'active'
  check (status in ('active', 'suspended', 'archived'));
alter table uniora.organizations add column if not exists status_changed_at timestamptz;
alter table uniora.organizations add column if not exists status_changed_by_provider text;
alter table uniora.organizations add column if not exists status_changed_by_subject text;
alter table uniora.organizations add column if not exists status_reason text check (status_reason is null or length(status_reason) <= 500);
create index if not exists organizations_status_created_at_idx on uniora.organizations (status, created_at, id);

create or replace function uniora.active_membership_id(p_org text, p_provider text, p_subject text)
returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select m.id
  from uniora.memberships m
  where m.organization_id = p_org
    and m.status = 'active'
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
