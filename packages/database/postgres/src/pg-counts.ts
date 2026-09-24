import type { Queryable } from "./queryable.js";

// Fixed allowlist of statements — never assembled from caller input.
const COUNT_BY_ORGANIZATION = {
  memberships: `select organization_id, count(*)::text as count
                from uniora.memberships where organization_id = any($1::text[]) group by organization_id`,
  roles: `select organization_id, count(*)::text as count
          from uniora.roles where organization_id = any($1::text[]) group by organization_id`,
  enabledFeatures: `select organization_id, count(*)::text as count
                    from uniora.features where enabled and organization_id = any($1::text[]) group by organization_id`,
} as const;

/**
 * Rows per organization for a batch of organization ids, in ONE grouped
 * query. Every requested id is present in the result (`0` when it has none),
 * so callers never need a per-organization lookup or a missing-key check.
 */
export async function countByOrganization(
  db: Queryable,
  source: keyof typeof COUNT_BY_ORGANIZATION,
  organizationIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(organizationIds.map((id) => [id, 0]));
  if (organizationIds.length === 0) return counts;
  const result = await db.query<{ organization_id: string; count: string }>(COUNT_BY_ORGANIZATION[source], [organizationIds]);
  for (const row of result.rows) counts[row.organization_id] = Number(row.count);
  return counts;
}
