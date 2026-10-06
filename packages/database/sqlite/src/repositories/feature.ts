import type { Feature, FeatureDefinition, FeatureRepository, FeatureUsage, RegisterFeatureInput, SearchFeaturesOptions } from "@uniora/core";
import { FeatureError, resolveFeatureKey, sanitizeFeatureName } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { countByOrganization } from "../counts.js";
import { jsonList } from "../json.js";
import { toLikePattern } from "../like.js";

interface FeatureRow {
  organization_id: string;
  key: string;
  enabled: number;
}

interface FeatureDefinitionRow {
  key: string;
  name: string;
  description: string | null;
}

function toFeature(row: FeatureRow): Feature {
  return { organizationId: row.organization_id, key: row.key, enabled: row.enabled === 1 };
}

function toFeatureDefinition(row: FeatureDefinitionRow): FeatureDefinition {
  return { key: row.key, name: row.name, description: row.description ?? undefined };
}

async function setEnabled(db: SqliteExecutor, organizationId: string, key: string, enabled: boolean): Promise<void> {
  // uniora_features has two foreign keys (organization -> organizations,
  // key -> feature_definitions) and SQLite reports neither by name, so
  // "not registered" is decided by looking, inside the same atomic unit as
  // the write — never by guessing which FK failed. An invalid organizationId
  // is a different failure mode (same as elsewhere in this package, e.g.
  // RoleRepository's/MembershipRepository's create(): it just propagates raw).
  await db.atomic(async () => {
    const registered = await db.query(`select 1 from uniora_feature_definitions where key = ?1`, [key]);
    if (registered.rowCount === 0) {
      throw new FeatureError(`Feature "${key}" is not registered. Call features.register() first.`);
    }
    await db.query(
      `insert into uniora_features (organization_id, key, enabled) values (?1, ?2, ?3)
       on conflict (organization_id, key) do update set enabled = excluded.enabled`,
      [organizationId, key, enabled],
    );
  });
}

export function createFeatureRepository(db: SqliteExecutor): FeatureRepository {
  return {
    async register(input: RegisterFeatureInput) {
      const name = sanitizeFeatureName(input.name);
      const key = resolveFeatureKey(name, input.key);
      const result = await db.query<FeatureDefinitionRow>(
        `insert into uniora_feature_definitions (key, name, description)
         values (?1, ?2, ?3)
         on conflict (key) do update set name = excluded.name, description = excluded.description
         returning key, name, description`,
        [key, name, input.description ?? null],
      );
      return toFeatureDefinition(result.rows[0]!);
    },

    async search(options?: SearchFeaturesOptions) {
      const query = options?.query?.trim();
      const result = await db.query<FeatureDefinitionRow>(
        `select key, name, description
         from uniora_feature_definitions
         where (?1 is null or uniora_ilike(key, ?1) or uniora_ilike(name, ?1))
           and (?2 is null or key > ?2)
           and (?4 is null or exists (
             select 1 from uniora_features f where f.organization_id = ?4 and f.key = uniora_feature_definitions.key and f.enabled = 1
           ))
         order by key asc
         limit coalesce(?3, -1)`,
        [query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.enabledIn ?? null],
      );
      return result.rows.map(toFeatureDefinition);
    },

    async count(options?: { query?: string; enabledIn?: string }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: number }>(
        `select count(*) as count
         from uniora_feature_definitions
         where (?1 is null or uniora_ilike(key, ?1) or uniora_ilike(name, ?1))
           and (?2 is null or exists (
             select 1 from uniora_features f where f.organization_id = ?2 and f.key = uniora_feature_definitions.key and f.enabled = 1
           ))`,
        [query ? toLikePattern(query) : null, options?.enabledIn ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async enabledKeys(organizationId: string, keys: string[]) {
      if (keys.length === 0) return [];
      const result = await db.query<{ key: string }>(
        `select key from uniora_features where organization_id = ?1 and enabled = 1 and key in (select value from json_each(?2))`,
        [organizationId, jsonList(keys)],
      );
      return result.rows.map((row) => row.key);
    },

    async countEnabledByOrganization(organizationIds: string[]) {
      return countByOrganization(db, "enabledFeatures", organizationIds);
    },

    async summarizeUsage(keys: string[], sampleSize: number) {
      const usage: Record<string, FeatureUsage> = Object.fromEntries(
        keys.map((key) => [key, { enabledCount: 0, sampleOrganizationIds: [] as string[] }]),
      );
      if (keys.length === 0) return usage;

      // One pass over the partial index (key, organization_id) where enabled:
      // a window function numbers each key's enabled rows in organization_id
      // order, so counting and sampling share a single query for the page.
      const result = await db.query<{ key: string; organization_id: string; rn: number; total: number }>(
        `select key, organization_id, rn, total
         from (
           select key, organization_id,
                  row_number() over (partition by key order by organization_id) as rn,
                  count(*) over (partition by key) as total
           from uniora_features
           where enabled = 1 and key in (select value from json_each(?1))
         ) s
         where rn <= ?2
         order by key, rn`,
        [jsonList(keys), sampleSize],
      );
      for (const row of result.rows) {
        const entry = usage[row.key]!;
        entry.enabledCount = Number(row.total);
        entry.sampleOrganizationIds.push(row.organization_id);
      }
      return usage;
    },

    async listCatalog() {
      const result = await db.query<FeatureDefinitionRow>(
        `select key, name, description from uniora_feature_definitions order by key asc`,
      );
      return result.rows.map(toFeatureDefinition);
    },

    async enable(organizationId: string, key: string) {
      await setEnabled(db, organizationId, key, true);
    },

    async disable(organizationId: string, key: string) {
      await setEnabled(db, organizationId, key, false);
    },

    async isEnabled(organizationId: string, key: string) {
      const result = await db.query<FeatureRow>(
        `select organization_id, key, enabled from uniora_features where organization_id = ?1 and key = ?2`,
        [organizationId, key],
      );
      return result.rows[0] ? result.rows[0].enabled === 1 : false;
    },

    async listByOrganization(organizationId: string) {
      const result = await db.query<FeatureRow>(
        `select organization_id, key, enabled from uniora_features where organization_id = ?1`,
        [organizationId],
      );
      return result.rows.map(toFeature);
    },

    async unregister(key: string) {
      // Same atomic WHERE-guarded DELETE pattern as
      // PermissionRepository.unregister: "not enabled anywhere" is decided in
      // the same statement as the delete. Rows left in uniora_features for
      // this key while disabled are removed by the real `on delete cascade`
      // on the key foreign key — they carry no access, so that is safe.
      const result = await db.query(
        `delete from uniora_feature_definitions
         where key = ?1
           and not exists (select 1 from uniora_features where key = ?1 and enabled = 1)`,
        [key],
      );
      if (result.rowCount > 0) return;

      const stillEnabled = await db.query(
        `select 1 from uniora_features where key = ?1 and enabled = 1 limit 1`,
        [key],
      );
      if (stillEnabled.rowCount > 0) {
        throw new FeatureError(
          `Cannot unregister feature "${key}": it is still enabled for at least one organization. Disable it everywhere first.`,
        );
      }
      throw new FeatureError(`Feature "${key}" is not registered.`);
    },
  };
}
