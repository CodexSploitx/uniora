import type {
  ConsumeResult,
  DefineEntitlementInput,
  EntitlementClock,
  EntitlementDefinition,
  EntitlementPeriod,
  EntitlementRepository,
  EntitlementStatus,
} from "@uniora/core";
import {
  EntitlementError,
  assertValidEntitlementAmount,
  assertValidEntitlementKey,
  assertValidEntitlementLimit,
  assertValidEntitlementPeriod,
  buildEntitlementStatus,
  entitlementWindow,
  sanitizeEntitlementName,
  toConsumeResult,
} from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";

interface DefinitionRow {
  key: string;
  name: string;
  description: string | null;
  period: EntitlementPeriod;
  default_limit: number | null;
}

interface LoadedRow extends DefinitionRow {
  org_exists: number;
  overridden: number;
  limit_value: number | null;
}

function toDefinition(row: DefinitionRow): EntitlementDefinition {
  return { key: row.key, name: row.name, description: row.description ?? undefined, period: row.period, defaultLimit: row.default_limit };
}

export function createEntitlementRepository(db: SqliteExecutor): EntitlementRepository {
  async function load(organizationId: string, key: string): Promise<LoadedRow> {
    const result = await db.query<LoadedRow>(
      `select d.key, d.name, d.description, d.period, d.default_limit,
              exists (select 1 from uniora_organizations where id = ?1) as org_exists,
              l.organization_id is not null as overridden, l.limit_value
       from uniora_entitlement_definitions d
       left join uniora_entitlement_limits l on l.organization_id = ?1 and l.key = d.key
       where d.key = ?2`,
      [organizationId, key],
    );
    const row = result.rows[0];
    if (!row) throw new EntitlementError(`Entitlement "${key}" is not defined.`, "entitlement_unknown");
    if (!row.org_exists) throw new EntitlementError(`Organization "${organizationId}" does not exist.`, "entitlement_organization_unknown");
    return row;
  }

  async function statusOf(organizationId: string, key: string, now: Date): Promise<EntitlementStatus> {
    const row = await load(organizationId, key);
    const window = entitlementWindow(row.period, now);
    const usage = await db.query<{ used: number }>(
      `select used from uniora_entitlement_usage where organization_id = ?1 and key = ?2 and window_start = ?3`,
      [organizationId, key, window.start],
    );
    return buildEntitlementStatus({
      organizationId,
      definition: { key, period: row.period, defaultLimit: row.default_limit },
      override: row.overridden ? { limit: row.limit_value } : undefined,
      used: usage.rows[0]?.used ?? 0,
      now,
    });
  }

  return {
    async define(input: DefineEntitlementInput) {
      const key = assertValidEntitlementKey(input.key);
      const name = sanitizeEntitlementName(input.name, key);
      const period = input.period === undefined ? "lifetime" : assertValidEntitlementPeriod(input.period);
      const defaultLimit = input.defaultLimit === undefined ? null : assertValidEntitlementLimit(input.defaultLimit);
      const result = await db.query<DefinitionRow>(
        `insert into uniora_entitlement_definitions (key, name, description, period, default_limit)
         values (?1, ?2, ?3, ?4, ?5)
         on conflict (key) do update set name = excluded.name, description = excluded.description,
           period = excluded.period, default_limit = excluded.default_limit
         returning key, name, description, period, default_limit`,
        [key, name, input.description?.trim() || null, period, defaultLimit],
      );
      return toDefinition(result.rows[0]!);
    },

    async findDefinition(key: string) {
      const result = await db.query<DefinitionRow>(
        `select key, name, description, period, default_limit from uniora_entitlement_definitions where key = ?1`,
        [key],
      );
      const row = result.rows[0];
      return row ? toDefinition(row) : null;
    },

    async listDefinitions() {
      const result = await db.query<DefinitionRow>(
        `select key, name, description, period, default_limit from uniora_entitlement_definitions order by key`,
      );
      return result.rows.map(toDefinition);
    },

    async undefine(key: string) {
      const result = await db.query(`delete from uniora_entitlement_definitions where key = ?1`, [key]);
      if (result.rowCount === 0) throw new EntitlementError(`Entitlement "${key}" is not defined.`, "entitlement_unknown");
    },

    async setLimit(organizationId: string, key: string, limit: number | null) {
      const checked = assertValidEntitlementLimit(limit);
      return db.atomic(async () => {
        await load(organizationId, key);
        await db.query(
          `insert into uniora_entitlement_limits (organization_id, key, limit_value, updated_at) values (?1, ?2, ?3, ?4)
           on conflict (organization_id, key) do update set limit_value = excluded.limit_value, updated_at = excluded.updated_at`,
          [organizationId, key, checked, new Date()],
        );
        return statusOf(organizationId, key, new Date());
      });
    },

    async clearLimit(organizationId: string, key: string) {
      return db.atomic(async () => {
        await load(organizationId, key);
        await db.query(`delete from uniora_entitlement_limits where organization_id = ?1 and key = ?2`, [organizationId, key]);
        return statusOf(organizationId, key, new Date());
      });
    },

    async get(organizationId: string, key: string, options?: EntitlementClock) {
      return db.atomic(() => statusOf(organizationId, key, options?.now ?? new Date()));
    },

    async list(organizationId: string, options?: EntitlementClock) {
      const now = options?.now ?? new Date();
      return db.atomic(async () => {
        const exists = await db.query(`select 1 from uniora_organizations where id = ?1`, [organizationId]);
        if (exists.rowCount === 0) throw new EntitlementError(`Organization "${organizationId}" does not exist.`, "entitlement_organization_unknown");
        const keys = await db.query<{ key: string }>(`select key from uniora_entitlement_definitions order by key`);
        const statuses: EntitlementStatus[] = [];
        for (const { key } of keys.rows) statuses.push(await statusOf(organizationId, key, now));
        return statuses;
      });
    },

    async consume(organizationId: string, key: string, amount = 1, options?: EntitlementClock): Promise<ConsumeResult> {
      assertValidEntitlementAmount(amount);
      const now = options?.now ?? new Date();
      // Read, check and take inside one `begin immediate` transaction: no other writer can interleave.
      return db.atomic(async () => {
        const row = await load(organizationId, key);
        const window = entitlementWindow(row.period, now);
        const limit = row.overridden ? row.limit_value : row.default_limit;
        const used = (
          await db.query<{ used: number }>(
            `select used from uniora_entitlement_usage where organization_id = ?1 and key = ?2 and window_start = ?3`,
            [organizationId, key, window.start],
          )
        ).rows[0]?.used ?? 0;
        if (limit !== null && used + amount > limit) return toConsumeResult(await statusOf(organizationId, key, now), false);
        await db.query(
          `insert into uniora_entitlement_usage (organization_id, key, window_start, used) values (?1, ?2, ?3, ?4)
           on conflict (organization_id, key, window_start) do update set used = used + excluded.used`,
          [organizationId, key, window.start, amount],
        );
        return toConsumeResult(await statusOf(organizationId, key, now), true);
      });
    },

    async release(organizationId: string, key: string, amount = 1, options?: EntitlementClock): Promise<ConsumeResult> {
      assertValidEntitlementAmount(amount);
      const now = options?.now ?? new Date();
      return db.atomic(async () => {
        const row = await load(organizationId, key);
        const window = entitlementWindow(row.period, now);
        await db.query(
          `update uniora_entitlement_usage set used = max(used - ?4, 0)
           where organization_id = ?1 and key = ?2 and window_start = ?3`,
          [organizationId, key, window.start, amount],
        );
        return toConsumeResult(await statusOf(organizationId, key, now), true);
      });
    },
  };
}
