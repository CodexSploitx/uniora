import type { Feature, FeatureDefinition, FeatureRepository, FeatureUsage, RegisterFeatureInput, SearchFeaturesOptions } from "@uniora/core";
import { FeatureError, resolveFeatureKey, sanitizeFeatureName } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { countByOrganization } from "../pg-counts.js";
import { isForeignKeyViolation, violatedConstraint } from "../pg-errors.js";
import { toLikePattern } from "../pg-like.js";

interface FeatureRow {
  organization_id: string;
  key: string;
  enabled: boolean;
}

interface FeatureDefinitionRow {
  key: string;
  name: string;
  description: string | null;
}

function toFeature(row: FeatureRow): Feature {
  return { organizationId: row.organization_id, key: row.key, enabled: row.enabled };
}

function toFeatureDefinition(row: FeatureDefinitionRow): FeatureDefinition {
  return { key: row.key, name: row.name, description: row.description ?? undefined };
}

async function setEnabled(db: Queryable, organizationId: string, key: string, enabled: boolean): Promise<void> {
  try {
    await db.query(
      `insert into uniora.features (organization_id, key, enabled) values ($1, $2, $3)
       on conflict (organization_id, key) do update set enabled = excluded.enabled`,
      [organizationId, key, enabled],
    );
  } catch (error) {
    // uniora.features has two FKs (organization_id -> organizations,
    // key -> feature_definitions) — only the latter means "not
    // registered". An invalid organizationId is a different failure
    // mode (same as elsewhere in this package, e.g. RoleRepository's/
    // MembershipRepository's create(), it just propagates raw).
    if (isForeignKeyViolation(error) && violatedConstraint(error) === "features_key_fkey") {
      throw new FeatureError(`Feature "${key}" is not registered. Call features.register() first.`);
    }
    throw error;
  }
}

export function createFeatureRepository(db: Queryable): FeatureRepository {
  return {
    async register(input: RegisterFeatureInput) {
      const name = sanitizeFeatureName(input.name);
      const key = resolveFeatureKey(name, input.key);
      const result = await db.query<FeatureDefinitionRow>(
        `insert into uniora.feature_definitions (key, name, description)
         values ($1, $2, $3)
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
         from uniora.feature_definitions
         where ($1::text is null or key ilike $1 or name ilike $1)
           and ($2::text is null or key > $2)
           and ($4::text is null or exists (
             select 1 from uniora.features f where f.organization_id = $4 and f.key = feature_definitions.key and f.enabled
           ))
         order by key asc
         limit $3`,
        [query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.enabledIn ?? null],
      );
      return result.rows.map(toFeatureDefinition);
    },

    async count(options?: { query?: string; enabledIn?: string }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.feature_definitions
         where ($1::text is null or key ilike $1 or name ilike $1)
           and ($2::text is null or exists (
             select 1 from uniora.features f where f.organization_id = $2 and f.key = feature_definitions.key and f.enabled
           ))`,
        [query ? toLikePattern(query) : null, options?.enabledIn ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async enabledKeys(organizationId: string, keys: string[]) {
      if (keys.length === 0) return [];
      const result = await db.query<{ key: string }>(
        `select key from uniora.features where organization_id = $1 and enabled and key = any($2::text[])`,
        [organizationId, keys],
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

      // One pass over the partial index (key, organization_id) where enabled
      // (migration 0012): a window function numbers each key's enabled rows
      // in organization_id order, so counting and sampling share a single
      // query for the whole page.
      const result = await db.query<{ key: string; organization_id: string; rn: string; total: string }>(
        `select key, organization_id, rn::text, total::text
         from (
           select key, organization_id,
                  row_number() over (partition by key order by organization_id) as rn,
                  count(*) over (partition by key) as total
           from uniora.features
           where enabled and key = any($1::text[])
         ) s
         where rn <= $2`,
        [keys, sampleSize],
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
        `select key, name, description from uniora.feature_definitions order by key asc`,
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
        `select organization_id, key, enabled from uniora.features where organization_id = $1 and key = $2`,
        [organizationId, key],
      );
      return result.rows[0]?.enabled ?? false;
    },

    async listByOrganization(organizationId: string) {
      const result = await db.query<FeatureRow>(
        `select organization_id, key, enabled from uniora.features where organization_id = $1`,
        [organizationId],
      );
      return result.rows.map(toFeature);
    },

    async unregister(key: string) {
      // Same atomic WHERE-guarded DELETE pattern as
      // PermissionRepository.unregister: "not enabled anywhere" must be
      // decided in the same statement as the delete. Rows left in
      // uniora.features for this key while disabled are removed by the
      // real `on delete cascade` on features_key_fkey (migration 0007) —
      // they carry no access, so cleaning them up here is safe.
      const result = await db.query(
        `delete from uniora.feature_definitions
         where key = $1
           and not exists (select 1 from uniora.features where key = $1 and enabled = true)`,
        [key],
      );
      if ((result.rowCount ?? 0) > 0) return;

      const stillEnabled = await db.query(
        `select 1 from uniora.features where key = $1 and enabled = true limit 1`,
        [key],
      );
      if ((stillEnabled.rowCount ?? 0) > 0) {
        throw new FeatureError(
          `Cannot unregister feature "${key}": it is still enabled for at least one organization. Disable it everywhere first.`,
        );
      }
      throw new FeatureError(`Feature "${key}" is not registered.`);
    },
  };
}
