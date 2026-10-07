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
import type { Queryable } from "../queryable.js";

interface DefinitionRow {
  key: string;
  name: string;
  description: string | null;
  period: EntitlementPeriod;
  default_limit: string | null;
}

interface LoadedRow extends DefinitionRow {
  org_exists: boolean;
  overridden: boolean;
  limit_value: string | null;
}

const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

function toDefinition(row: DefinitionRow): EntitlementDefinition {
  return {
    key: row.key,
    name: row.name,
    description: row.description ?? undefined,
    period: row.period,
    defaultLimit: toNumber(row.default_limit),
  };
}

export function createEntitlementRepository(db: Queryable): EntitlementRepository {
  /** The definition, this organization's override and whether the organization exists, in one read. */
  async function load(organizationId: string, key: string): Promise<LoadedRow> {
    const result = await db.query<LoadedRow>(
      `select d.key, d.name, d.description, d.period, d.default_limit,
              exists (select 1 from uniora.organizations where id = $1) as org_exists,
              l.organization_id is not null as overridden, l.limit_value
       from uniora.entitlement_definitions d
       left join uniora.entitlement_limits l on l.organization_id = $1 and l.key = d.key
       where d.key = $2`,
      [organizationId, key],
    );
    const row = result.rows[0];
    if (!row) throw new EntitlementError(`Entitlement "${key}" is not defined.`, "entitlement_unknown");
    if (!row.org_exists) throw new EntitlementError(`Organization "${organizationId}" does not exist.`, "entitlement_organization_unknown");
    return row;
  }

  const override = (row: LoadedRow) => (row.overridden ? { limit: toNumber(row.limit_value) } : undefined);

  async function statusOf(organizationId: string, key: string, now: Date): Promise<EntitlementStatus> {
    const row = await load(organizationId, key);
    const window = entitlementWindow(row.period, now);
    const usage = await db.query<{ used: string }>(
      `select used from uniora.entitlement_usage where organization_id = $1 and key = $2 and window_start = $3`,
      [organizationId, key, window.start],
    );
    return buildEntitlementStatus({
      organizationId,
      definition: { key, period: row.period, defaultLimit: toNumber(row.default_limit) },
      override: override(row),
      used: Number(usage.rows[0]?.used ?? 0),
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
        `insert into uniora.entitlement_definitions (key, name, description, period, default_limit)
         values ($1, $2, $3, $4, $5)
         on conflict (key) do update set name = excluded.name, description = excluded.description,
           period = excluded.period, default_limit = excluded.default_limit
         returning key, name, description, period, default_limit`,
        [key, name, input.description?.trim() || null, period, defaultLimit],
      );
      return toDefinition(result.rows[0]!);
    },

    async findDefinition(key: string) {
      const result = await db.query<DefinitionRow>(
        `select key, name, description, period, default_limit from uniora.entitlement_definitions where key = $1`,
        [key],
      );
      const row = result.rows[0];
      return row ? toDefinition(row) : null;
    },

    async listDefinitions() {
      const result = await db.query<DefinitionRow>(
        `select key, name, description, period, default_limit from uniora.entitlement_definitions order by key`,
      );
      return result.rows.map(toDefinition);
    },

    async undefine(key: string) {
      const result = await db.query(`delete from uniora.entitlement_definitions where key = $1`, [key]);
      if ((result.rowCount ?? 0) === 0) throw new EntitlementError(`Entitlement "${key}" is not defined.`, "entitlement_unknown");
    },

    async setLimit(organizationId: string, key: string, limit: number | null) {
      const checked = assertValidEntitlementLimit(limit);
      await load(organizationId, key);
      await db.query(
        `insert into uniora.entitlement_limits (organization_id, key, limit_value) values ($1, $2, $3)
         on conflict (organization_id, key) do update set limit_value = excluded.limit_value, updated_at = now()`,
        [organizationId, key, checked],
      );
      return statusOf(organizationId, key, new Date());
    },

    async clearLimit(organizationId: string, key: string) {
      await load(organizationId, key);
      await db.query(`delete from uniora.entitlement_limits where organization_id = $1 and key = $2`, [organizationId, key]);
      return statusOf(organizationId, key, new Date());
    },

    async get(organizationId: string, key: string, options?: EntitlementClock) {
      return statusOf(organizationId, key, options?.now ?? new Date());
    },

    async list(organizationId: string, options?: EntitlementClock) {
      const now = options?.now ?? new Date();
      const exists = await db.query(`select 1 from uniora.organizations where id = $1`, [organizationId]);
      if ((exists.rowCount ?? 0) === 0) throw new EntitlementError(`Organization "${organizationId}" does not exist.`, "entitlement_organization_unknown");
      const definitions = await db.query<DefinitionRow & { overridden: boolean; limit_value: string | null }>(
        `select d.key, d.name, d.description, d.period, d.default_limit, l.organization_id is not null as overridden, l.limit_value
         from uniora.entitlement_definitions d
         left join uniora.entitlement_limits l on l.organization_id = $1 and l.key = d.key
         order by d.key`,
        [organizationId],
      );
      if (definitions.rows.length === 0) return [];
      const windows = definitions.rows.map((row) => entitlementWindow(row.period, now).start);
      const usage = await db.query<{ key: string; used: string }>(
        `select u.key, u.used
         from uniora.entitlement_usage u
         join unnest($2::text[], $3::timestamptz[]) as w (key, window_start) on w.key = u.key and w.window_start = u.window_start
         where u.organization_id = $1`,
        [organizationId, definitions.rows.map((row) => row.key), windows],
      );
      const used = new Map(usage.rows.map((row) => [row.key, Number(row.used)]));
      return definitions.rows.map((row) =>
        buildEntitlementStatus({
          organizationId,
          definition: { key: row.key, period: row.period, defaultLimit: toNumber(row.default_limit) },
          override: row.overridden ? { limit: toNumber(row.limit_value) } : undefined,
          used: used.get(row.key) ?? 0,
          now,
        }),
      );
    },

    async consume(organizationId: string, key: string, amount = 1, options?: EntitlementClock): Promise<ConsumeResult> {
      assertValidEntitlementAmount(amount);
      const now = options?.now ?? new Date();
      const row = await load(organizationId, key);
      const window = entitlementWindow(row.period, now);
      // ONE statement: the limit is read and the usage taken under the row lock of the upsert, so concurrent
      // consumers serialize on it and the sum never passes the limit. `ins` returns nothing when it would.
      const taken = await db.query<{ used: string | null }>(
        `with eff as (
           select case when l.organization_id is not null then l.limit_value else d.default_limit end as lim
           from uniora.entitlement_definitions d
           left join uniora.entitlement_limits l on l.organization_id = $1 and l.key = d.key
           where d.key = $2
         ), ins as (
           insert into uniora.entitlement_usage as u (organization_id, key, window_start, used)
           select $1::text, $2::text, $3::timestamptz, $4::bigint from eff where lim is null or $4::bigint <= lim
           on conflict (organization_id, key, window_start) do update set used = u.used + excluded.used
             where (select lim from eff) is null or u.used + excluded.used <= (select lim from eff)
           returning used
         )
         select (select used from ins) as used`,
        [organizationId, key, window.start, amount],
      );
      if (taken.rows[0]?.used != null) return toConsumeResult(await statusOf(organizationId, key, now), true);
      return toConsumeResult(await statusOf(organizationId, key, now), false);
    },

    async release(organizationId: string, key: string, amount = 1, options?: EntitlementClock): Promise<ConsumeResult> {
      assertValidEntitlementAmount(amount);
      const now = options?.now ?? new Date();
      const row = await load(organizationId, key);
      const window = entitlementWindow(row.period, now);
      await db.query(
        `update uniora.entitlement_usage set used = greatest(used - $4::bigint, 0)
         where organization_id = $1 and key = $2 and window_start = $3`,
        [organizationId, key, window.start, amount],
      );
      return toConsumeResult(await statusOf(organizationId, key, now), true);
    },
  };
}
