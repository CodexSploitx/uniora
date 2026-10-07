/**
 * Organization status (`active` | `suspended` | `archived`) and who/when/why it last changed — same model as
 * `@uniora/postgres`'s `0023_organization_status`. Every existing organization is `active`; the history of changes is
 * the audit log's job (`organization.status_changed`).
 */
export const MIGRATION_0008_ORGANIZATION_STATUS = `
alter table uniora_organizations add column status text not null default 'active' check (status in ('active', 'suspended', 'archived'));
alter table uniora_organizations add column status_changed_at text;
alter table uniora_organizations add column status_changed_by_provider text;
alter table uniora_organizations add column status_changed_by_subject text;
alter table uniora_organizations add column status_reason text check (status_reason is null or length(status_reason) <= 500);
create index if not exists uniora_organizations_status_idx on uniora_organizations (status, created_at, id);
`;
