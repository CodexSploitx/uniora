import type { Permission, PermissionRepository, RegisterPermissionInput, SearchPermissionsOptions } from "@uniora/core";
import {
  PermissionError,
  assertValidImplications,
  assertValidPermissionKey,
  sanitizeImplies,
  sanitizePermissionGroup,
  sanitizePermissionName,
} from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { jsonList, parseList } from "../json.js";
import { toLikePattern } from "../like.js";

interface PermissionRow {
  key: string;
  name: string | null;
  description: string | null;
  group_key: string | null;
  implies: string;
}

const COLUMNS = `p.key, p.name, p.description, p.group_key,
  coalesce((select json_group_array(pi.implied_key order by pi.implied_key) from uniora_permission_implications pi where pi.permission_key = p.key), '[]') as implies`;

function toPermission(row: PermissionRow): Permission {
  const implies = parseList(row.implies);
  return {
    key: row.key,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    ...(row.group_key !== null ? { group: row.group_key } : {}),
    ...(implies.length > 0 ? { implies } : {}),
  };
}

export function createPermissionRepository(db: SqliteExecutor): PermissionRepository {
  return {
    async register(input: RegisterPermissionInput) {
      const key = assertValidPermissionKey(input.key);
      const name = input.name !== undefined ? sanitizePermissionName(input.name) : undefined;
      const group = sanitizePermissionGroup(input.group);
      const implies = sanitizeImplies(input.implies);
      return db.atomic(async () => {
        if (implies.length > 0) {
          const rows = await db.query<{ permission_key: string; implied_key: string | null }>(
            `select p.key as permission_key, pi.implied_key
             from uniora_permissions p left join uniora_permission_implications pi on pi.permission_key = p.key`,
          );
          const graph = new Map<string, string[]>();
          for (const row of rows.rows) {
            const list = graph.get(row.permission_key) ?? [];
            if (row.implied_key !== null) list.push(row.implied_key);
            graph.set(row.permission_key, list);
          }
          assertValidImplications(graph, key, implies);
        }
        await db.query(
          `insert into uniora_permissions (key, name, description, group_key)
           values (?1, ?2, ?3, ?4)
           on conflict (key) do update set name = excluded.name, description = excluded.description, group_key = excluded.group_key`,
          [key, name ?? null, input.description ?? null, group ?? null],
        );
        await db.query(
          `delete from uniora_permission_implications
           where permission_key = ?1 and implied_key not in (select value from json_each(?2))`,
          [key, jsonList(implies)],
        );
        await db.query(
          `insert into uniora_permission_implications (permission_key, implied_key)
           select ?1, value from json_each(?2) where true on conflict do nothing`,
          [key, jsonList(implies)],
        );
        const result = await db.query<PermissionRow>(`select ${COLUMNS} from uniora_permissions p where p.key = ?1`, [key]);
        return toPermission(result.rows[0]!);
      });
    },

    async findByKey(key: string) {
      const result = await db.query<PermissionRow>(
        `select ${COLUMNS} from uniora_permissions p where p.key = ?1`,
        [key],
      );
      return result.rows[0] ? toPermission(result.rows[0]) : null;
    },

    async list() {
      const result = await db.query<PermissionRow>(
        `select ${COLUMNS} from uniora_permissions p order by p.key asc`,
      );
      return result.rows.map(toPermission);
    },

    async search(options?: SearchPermissionsOptions) {
      const query = options?.query?.trim();
      const result = await db.query<PermissionRow>(
        `select ${COLUMNS}
         from uniora_permissions p
         where (?1 is null or uniora_ilike(p.key, ?1) or uniora_ilike(p.name, ?1))
           and (?2 is null or p.key > ?2)
           and (?4 is null or exists (
             select 1 from uniora_role_permissions rp where rp.role_id = ?4 and rp.permission_key = p.key
           ))
           and (?5 is null or exists (
             select 1 from uniora_role_permissions rp
             join uniora_membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = ?5 and rp.permission_key = p.key
           ))
           and (?6 is null or p.group_key = ?6)
         order by p.key asc
         limit coalesce(?3, -1)`,
        [query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.grantedToRole ?? null, options?.grantedToMember ?? null, options?.group ?? null],
      );
      return result.rows.map(toPermission);
    },

    async count(options?: { query?: string; group?: string; grantedToRole?: string; grantedToMember?: string }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: number }>(
        `select count(*) as count
         from uniora_permissions p
         where (?1 is null or uniora_ilike(p.key, ?1) or uniora_ilike(p.name, ?1))
           and (?2 is null or exists (
             select 1 from uniora_role_permissions rp where rp.role_id = ?2 and rp.permission_key = p.key
           ))
           and (?3 is null or exists (
             select 1 from uniora_role_permissions rp
             join uniora_membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = ?3 and rp.permission_key = p.key
           ))
           and (?4 is null or p.group_key = ?4)`,
        [query ? toLikePattern(query) : null, options?.grantedToRole ?? null, options?.grantedToMember ?? null, options?.group ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async countRoleGrants(keys: string[]) {
      const counts: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
      if (keys.length === 0) return counts;
      const result = await db.query<{ permission_key: string; count: number }>(
        `select permission_key, count(*) as count
         from uniora_role_permissions
         where permission_key in (select value from json_each(?1))
         group by permission_key`,
        [jsonList(keys)],
      );
      for (const row of result.rows) counts[row.permission_key] = Number(row.count);
      return counts;
    },

    async impliedBy(key: string) {
      const result = await db.query<{ key: string }>(
        `with recursive up(key, depth) as (
           select permission_key, 1 from uniora_permission_implications where implied_key = ?1
           union
           select pi.permission_key, up.depth + 1
           from uniora_permission_implications pi join up on pi.implied_key = up.key
           where up.depth < 9
         )
         select distinct key from up where key <> ?1 order by key`,
        [key],
      );
      return result.rows.map((row) => row.key);
    },

    async expand(keys: string[]) {
      if (keys.length === 0) return [];
      const result = await db.query<{ key: string }>(
        `with recursive down(key, depth) as (
           select value, 0 from json_each(?1)
           union
           select pi.implied_key, down.depth + 1
           from uniora_permission_implications pi join down on pi.permission_key = down.key
           where down.depth < 9
         )
         select distinct key from down order by key`,
        [jsonList(keys)],
      );
      return result.rows.map((row) => row.key);
    },

    async unregister(key: string) {
      // One WHERE-guarded DELETE, same pattern as the Postgres adapter:
      // "not granted to any role" is decided by the very statement that
      // deletes, never by a read that could go stale before it.
      const result = await db.query(
        `delete from uniora_permissions
         where key = ?1
           and not exists (select 1 from uniora_role_permissions where permission_key = ?1)
           and not exists (select 1 from uniora_permission_implications where implied_key = ?1)`,
        [key],
      );
      if (result.rowCount > 0) return;

      const dependents = await db.query(`select 1 from uniora_permission_implications where implied_key = ?1 limit 1`, [key]);
      if (dependents.rowCount > 0) {
        throw new PermissionError(
          `Cannot unregister permission "${key}": another permission still implies it. Change that one first.`,
          "permission_has_dependents",
        );
      }

      const stillGranted = await db.query(
        `select 1 from uniora_role_permissions where permission_key = ?1 limit 1`,
        [key],
      );
      if (stillGranted.rowCount > 0) {
        throw new PermissionError(
          `Cannot unregister permission "${key}": it is still granted to at least one role. Revoke it everywhere first.`,
        );
      }
      throw new PermissionError(`Permission not found: ${key}`);
    },
  };
}
