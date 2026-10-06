import type {
  EffectiveFeature,
  Feature,
  FeatureChangeMeta,
  FeatureDefinition,
  FeatureRepository,
  FeatureUsage,
  RegisterFeatureInput,
  SearchFeaturesOptions,
} from "@uniora/core";
import {
  FeatureError,
  assertValidFeatureParent,
  featureRequirements,
  resolveEffectiveFeatures,
  resolveFeatureKey,
  sanitizeFeatureChangeReason,
  sanitizeFeatureName,
} from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { toLikePattern } from "../pg-like.js";

interface FeatureRow {
  organization_id: string;
  key: string;
  enabled: boolean;
  updated_at: Date | null;
  updated_by_provider: string | null;
  updated_by_subject: string | null;
  reason: string | null;
}

interface FeatureDefinitionRow {
  key: string;
  name: string;
  description: string | null;
  default_enabled: boolean;
  parent_key: string | null;
}

const DEFINITION_COLUMNS = "key, name, description, default_enabled, parent_key";
const OVERRIDE_COLUMNS = "organization_id, key, enabled, updated_at, updated_by_provider, updated_by_subject, reason";

function toFeature(row: FeatureRow): Feature {
  return {
    organizationId: row.organization_id,
    key: row.key,
    enabled: row.enabled,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(row.updated_by_provider !== null && row.updated_by_subject !== null
      ? { updatedBy: { provider: row.updated_by_provider, subject: row.updated_by_subject } }
      : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}

function toFeatureDefinition(row: FeatureDefinitionRow): FeatureDefinition {
  return {
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    defaultEnabled: row.default_enabled,
    ...(row.parent_key !== null ? { parentKey: row.parent_key } : {}),
  };
}

const unknownFeature = (key: string): FeatureError =>
  new FeatureError(`Feature "${key}" is not registered. Call features.register() first.`, "feature_unknown");

async function loadDefinitions(db: Queryable): Promise<FeatureDefinition[]> {
  const result = await db.query<FeatureDefinitionRow>(`select ${DEFINITION_COLUMNS} from uniora.feature_definitions order by key asc`);
  return result.rows.map(toFeatureDefinition);
}

async function loadOverrides(db: Queryable, organizationIds: string[]): Promise<Feature[]> {
  if (organizationIds.length === 0) return [];
  const result = await db.query<FeatureRow>(
    `select ${OVERRIDE_COLUMNS} from uniora.features where organization_id = any($1::text[])`,
    [organizationIds],
  );
  return result.rows.map(toFeature);
}

async function effectiveFor(db: Queryable, organizationId: string): Promise<EffectiveFeature[]> {
  const [definitions, overrides] = await Promise.all([loadDefinitions(db), loadOverrides(db, [organizationId])]);
  return resolveEffectiveFeatures(definitions, overrides);
}

function changeParams(meta?: FeatureChangeMeta): [string | null, string | null, string | null] {
  return [meta?.actor?.provider ?? null, meta?.actor?.subject ?? null, sanitizeFeatureChangeReason(meta?.reason) ?? null];
}

/**
 * Writes the overrides in ONE statement (atomic with or without an enclosing transaction), after checking that
 * every key is registered — so a bad key never leaves a half-applied batch and the error can name it.
 */
async function applyOverrides(
  db: Queryable,
  organizationId: string,
  entries: ReadonlyArray<readonly [string, boolean]>,
  meta?: FeatureChangeMeta,
): Promise<void> {
  if (entries.length === 0) return;
  const keys = entries.map(([key]) => key);
  const known = await db.query<{ key: string }>(`select key from uniora.feature_definitions where key = any($1::text[])`, [keys]);
  const registered = new Set(known.rows.map((row) => row.key));
  const missing = keys.find((key) => !registered.has(key));
  if (missing !== undefined) throw unknownFeature(missing);

  const [provider, subject, reason] = changeParams(meta);
  await db.query(
    // An invalid organizationId violates the other FK and just propagates raw, as elsewhere in this package.
    `insert into uniora.features (organization_id, key, enabled, updated_at, updated_by_provider, updated_by_subject, reason)
     select $1, c.key, c.enabled, date_trunc('milliseconds', now()), $4, $5, $6
     from unnest($2::text[], $3::boolean[]) as c(key, enabled)
     on conflict (organization_id, key) do update set
       enabled = excluded.enabled, updated_at = excluded.updated_at,
       updated_by_provider = excluded.updated_by_provider, updated_by_subject = excluded.updated_by_subject,
       reason = excluded.reason`,
    [organizationId, keys, entries.map(([, enabled]) => enabled), provider, subject, reason],
  );
}

export function createFeatureRepository(db: Queryable): FeatureRepository {
  const repository: FeatureRepository = {
    async register(input: RegisterFeatureInput) {
      const name = sanitizeFeatureName(input.name);
      const key = resolveFeatureKey(name, input.key);
      if (input.parentKey !== undefined) {
        const catalog = await loadDefinitions(db);
        assertValidFeatureParent(new Map(catalog.map((definition) => [definition.key, definition])), key, input.parentKey);
      }
      const result = await db.query<FeatureDefinitionRow>(
        `insert into uniora.feature_definitions (key, name, description, default_enabled, parent_key)
         values ($1, $2, $3, $4, $5)
         on conflict (key) do update set
           name = excluded.name, description = excluded.description,
           default_enabled = excluded.default_enabled, parent_key = excluded.parent_key
         returning ${DEFINITION_COLUMNS}`,
        [key, name, input.description ?? null, input.defaultEnabled === true, input.parentKey ?? null],
      );
      return toFeatureDefinition(result.rows[0]!);
    },

    async search(options?: SearchFeaturesOptions) {
      const query = options?.query?.trim();
      const result = await db.query<FeatureDefinitionRow>(
        `select ${DEFINITION_COLUMNS}
         from uniora.feature_definitions
         where ($1::text is null or key ilike $1 or name ilike $1)
           and ($2::text is null or key > $2)
         order by key asc`,
        [query ? toLikePattern(query) : null, options?.after ?? null],
      );
      let definitions = result.rows.map(toFeatureDefinition);
      // "Effectively enabled in X" is resolved against the catalog (small) in code, so the rule has one definition.
      if (options?.enabledIn !== undefined) {
        const on = new Set((await effectiveFor(db, options.enabledIn)).filter((feature) => feature.enabled).map((feature) => feature.key));
        definitions = definitions.filter((definition) => on.has(definition.key));
      }
      return options?.limit !== undefined ? definitions.slice(0, options.limit) : definitions;
    },

    async count(options?: { query?: string; enabledIn?: string }) {
      const query = options?.query?.trim();
      if (options?.enabledIn === undefined) {
        const result = await db.query<{ count: string }>(
          `select count(*)::text as count from uniora.feature_definitions where ($1::text is null or key ilike $1 or name ilike $1)`,
          [query ? toLikePattern(query) : null],
        );
        return Number(result.rows[0]!.count);
      }
      return (await repository.search({ query: options.query, enabledIn: options.enabledIn })).length;
    },

    async enabledKeys(organizationId: string, keys: string[]) {
      if (keys.length === 0) return [];
      const wanted = new Set(keys);
      return (await effectiveFor(db, organizationId)).filter((feature) => feature.enabled && wanted.has(feature.key)).map((feature) => feature.key);
    },

    async countEnabledByOrganization(organizationIds: string[]) {
      const counts: Record<string, number> = Object.fromEntries(organizationIds.map((id) => [id, 0]));
      if (organizationIds.length === 0) return counts;
      const [definitions, overrides] = await Promise.all([loadDefinitions(db), loadOverrides(db, organizationIds)]);
      for (const organizationId of organizationIds) {
        const own = overrides.filter((row) => row.organizationId === organizationId);
        counts[organizationId] = resolveEffectiveFeatures(definitions, own).filter((feature) => feature.enabled).length;
      }
      return counts;
    },

    async summarizeUsage(keys: string[], sampleSize: number) {
      const usage: Record<string, FeatureUsage> = Object.fromEntries(
        keys.map((key) => [key, { enabledCount: 0, sampleOrganizationIds: [] as string[] }]),
      );
      if (keys.length === 0) return usage;

      const catalog = new Map((await loadDefinitions(db)).map((definition) => [definition.key, definition]));
      for (const key of keys) {
        const { chain, requiredOn, complete } = featureRequirements(catalog, key);
        if (!complete) continue;
        // An organization has the feature effectively on when every chain feature that is off by default has an
        // explicit "on" override, and no chain feature has an explicit "off" one.
        const where = `where (select count(*) from uniora.features f
                              where f.organization_id = o.id and f.enabled and f.key = any($1::text[])) = $3::int
                         and not exists (select 1 from uniora.features f
                                         where f.organization_id = o.id and not f.enabled and f.key = any($2::text[]))`;
        const params = [requiredOn, chain, requiredOn.length];
        const sample = sampleSize > 0
          ? await db.query<{ id: string; total: string }>(
              `select o.id, (count(*) over ())::text as total from uniora.organizations o ${where} order by o.id limit $4`,
              [...params, sampleSize],
            )
          : undefined;
        if (sample && sample.rows.length > 0) {
          usage[key] = { enabledCount: Number(sample.rows[0]!.total), sampleOrganizationIds: sample.rows.map((row) => row.id) };
        } else if (!sample || sample.rows.length === 0) {
          const total = await db.query<{ count: string }>(`select count(*)::text as count from uniora.organizations o ${where}`, params);
          usage[key] = { enabledCount: Number(total.rows[0]!.count), sampleOrganizationIds: [] };
        }
      }
      return usage;
    },

    async listCatalog() {
      return loadDefinitions(db);
    },

    async enable(organizationId: string, key: string, meta?: FeatureChangeMeta) {
      await applyOverrides(db, organizationId, [[key, true]], meta);
    },

    async disable(organizationId: string, key: string, meta?: FeatureChangeMeta) {
      await applyOverrides(db, organizationId, [[key, false]], meta);
    },

    async setMany(organizationId: string, changes: Record<string, boolean>, meta?: FeatureChangeMeta) {
      await applyOverrides(db, organizationId, Object.entries(changes), meta);
    },

    async disableEverywhere(key: string, meta?: FeatureChangeMeta) {
      const [provider, subject, reason] = changeParams(meta);
      // One statement: the default flips and every override is switched off together, so a concurrent
      // enable() cannot slip between the two halves of the kill switch.
      const result = await db.query<{ was_default: boolean; disabled: string }>(
        `with target as (select key, default_enabled from uniora.feature_definitions where key = $1 for update),
              flipped as (update uniora.feature_definitions d set default_enabled = false from target t where d.key = t.key returning d.key),
              disabled as (
                update uniora.features f set enabled = false, updated_at = date_trunc('milliseconds', now()),
                  updated_by_provider = $2, updated_by_subject = $3, reason = $4
                from target t where f.key = t.key and f.enabled returning f.organization_id
              )
         select (select default_enabled from target) as was_default, (select count(*) from disabled)::text as disabled
         from target`,
        [key, provider, subject, reason],
      );
      const row = result.rows[0];
      if (!row) throw unknownFeature(key);
      return { disabledOverrides: Number(row.disabled), defaultWasEnabled: row.was_default };
    },

    async isEnabled(organizationId: string, key: string) {
      return (await effectiveFor(db, organizationId)).some((feature) => feature.key === key && feature.enabled);
    },

    async listEffective(organizationId: string, options?: { keys?: string[] }) {
      const all = await effectiveFor(db, organizationId);
      return options?.keys ? all.filter((feature) => options.keys!.includes(feature.key)) : all;
    },

    async listByOrganization(organizationId: string) {
      return (await loadOverrides(db, [organizationId]));
    },

    async unregister(key: string) {
      // Same atomic WHERE-guarded DELETE pattern as PermissionRepository.unregister: "not enabled anywhere" and
      // "nothing depends on it" are decided in the same statement as the delete. "Enabled" means an explicit "on"
      // override, or the feature being on by default for at least one organization that has no "off" override.
      // Rows left in uniora.features for this key while disabled go away through the real `on delete cascade`.
      const result = await db.query(
        `delete from uniora.feature_definitions d
         where d.key = $1
           and not exists (select 1 from uniora.feature_definitions c where c.parent_key = d.key)
           and not exists (select 1 from uniora.features f where f.key = d.key and f.enabled)
           and not (d.default_enabled and exists (
             select 1 from uniora.organizations o
             where not exists (select 1 from uniora.features f where f.organization_id = o.id and f.key = d.key and not f.enabled)
           ))`,
        [key],
      );
      if ((result.rowCount ?? 0) > 0) return;

      const state = await db.query<{ has_children: boolean }>(
        `select exists (select 1 from uniora.feature_definitions c where c.parent_key = $1) as has_children
         from uniora.feature_definitions where key = $1`,
        [key],
      );
      if (state.rows.length === 0) throw new FeatureError(`Feature "${key}" is not registered.`, "feature_unknown");
      if (state.rows[0]!.has_children) {
        throw new FeatureError(
          `Cannot unregister feature "${key}": other features depend on it. Unregister or detach them first.`,
          "feature_has_children",
        );
      }
      throw new FeatureError(
        `Cannot unregister feature "${key}": it is still enabled for at least one organization. Disable it everywhere first.`,
        "feature_in_use",
      );
    },
  };
  return repository;
}
