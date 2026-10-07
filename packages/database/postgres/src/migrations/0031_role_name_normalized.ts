/**
 * Role names are unique per organization in a normalized form (lowercase, no diacritics, collapsed whitespace; see
 * `normalizeRoleName` in `@uniora/core`), so "Recepción", "recepcion" and "RECEPCIÓN" can no longer coexist. The library
 * stores that form in `name_normalized`; the unique index makes it hold under concurrent writes. It replaces the old
 * exact `(organization_id, name)` index, which the new one implies.
 *
 * Existing roles are backfilled here with the same rule (`normalize(..., NFD)` without combining marks, lowercased).
 * If an organization already has roles that differ only in case or accents, the first one (by id) keeps the plain form
 * and the others get `#<id>` appended, so the migration cannot fail on legacy data; rename them when convenient.
 */
export const MIGRATION_0031_ROLE_NAME_NORMALIZED = `
alter table uniora.roles add column if not exists name_normalized text;

update uniora.roles
set name_normalized = lower(regexp_replace(normalize(name, NFD), '[\\u0300-\\u036f]', '', 'g'))
where name_normalized is null;

update uniora.roles r
set name_normalized = r.name_normalized || '#' || r.id
from (
  select id, row_number() over (partition by organization_id, name_normalized order by id) as position
  from uniora.roles
) ranked
where ranked.id = r.id and ranked.position > 1;

alter table uniora.roles alter column name_normalized set not null;
drop index if exists uniora.roles_org_name_key;
create unique index if not exists roles_org_name_normalized_key on uniora.roles (organization_id, name_normalized);
`;
