import type { Queryable } from "./queryable.js";

// Fixed allowlist of statements — never assembled from caller input. Each organization is counted on its own, inside a
// `limit`, so one organization with millions of rows costs `limit` index entries, not millions.
const COUNT_BY_ORGANIZATION = {
  memberships: `select o.id as organization_id,
                       (select count(*) from (select 1 from uniora.memberships m where m.organization_id = o.id limit $2::integer) c)::text as count
                from unnest($1::text[]) as o(id)`,
  roles: `select o.id as organization_id,
                 (select count(*) from (select 1 from uniora.roles r where r.organization_id = o.id limit $2::integer) c)::text as count
          from unnest($1::text[]) as o(id)`,
} as const;

/**
 * Rows per organization for a batch of organization ids, in ONE query. Every requested id is present in the result
 * (`0` when it has none), so callers never need a per-organization lookup or a missing-key check. With `limit`, each
 * count stops there ("at least this many").
 */
export async function countByOrganization(
  db: Queryable,
  source: keyof typeof COUNT_BY_ORGANIZATION,
  organizationIds: string[],
  limit?: number,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(organizationIds.map((id) => [id, 0]));
  if (organizationIds.length === 0) return counts;
  const result = await db.query<{ organization_id: string; count: string }>(COUNT_BY_ORGANIZATION[source], [organizationIds, limit ?? null]);
  for (const row of result.rows) counts[row.organization_id] = Number(row.count);
  return counts;
}
