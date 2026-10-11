/**
 * The policy kinds `contextual` (conditions on the time and on request signals) and `sensitive` (conditions on how strongly the
 * person authenticated) join `access`, `resource`, `scope` and `feature`.
 *
 * Only the allowed values of `kind` change; no row is touched. The check on `kind` (the definition's `kind` must equal the column)
 * stays as it was. The definition language decides which kinds a release accepts: the schema accepts both new names together so
 * that the release that adds the second one needs no new migration.
 */
export const MIGRATION_0042_POLICY_KINDS = `
alter table uniora.policies drop constraint if exists policies_kind_check;
alter table uniora.policies add constraint policies_kind_check
  check (kind in ('access', 'resource', 'scope', 'feature', 'contextual', 'sensitive'));
`;
