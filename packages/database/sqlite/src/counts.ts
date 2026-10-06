import type { SqliteExecutor } from "./executor.js";
import { jsonList } from "./json.js";

// Fixed allowlist of statements — never assembled from caller input.
const COUNT_BY_ORGANIZATION = {
  memberships: `select organization_id, count(*) as count
                from uniora_memberships where organization_id in (select value from json_each(?1)) group by organization_id`,
  roles: `select organization_id, count(*) as count
          from uniora_roles where organization_id in (select value from json_each(?1)) group by organization_id`,
  enabledFeatures: `select organization_id, count(*) as count
                    from uniora_features where enabled = 1 and organization_id in (select value from json_each(?1)) group by organization_id`,
} as const;

/**
 * Rows per organization for a batch of organization ids, in ONE grouped
 * query. Every requested id is present in the result (`0` when it has none),
 * so callers never need a per-organization lookup or a missing-key check.
 */
export async function countByOrganization(
  db: SqliteExecutor,
  source: keyof typeof COUNT_BY_ORGANIZATION,
  organizationIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = Object.fromEntries(organizationIds.map((id) => [id, 0]));
  if (organizationIds.length === 0) return counts;
  const result = await db.query<{ organization_id: string; count: number }>(COUNT_BY_ORGANIZATION[source], [
    jsonList(organizationIds),
  ]);
  for (const row of result.rows) counts[row.organization_id] = Number(row.count);
  return counts;
}
