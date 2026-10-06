import type { Permission, PermissionRepository, RegisterPermissionInput, SearchPermissionsOptions } from "@uniora/core";
import { PermissionError, assertValidPermissionKey, sanitizePermissionName } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { jsonList } from "../json.js";
import { toLikePattern } from "../like.js";

interface PermissionRow {
  key: string;
  name: string | null;
  description: string | null;
}

function toPermission(row: PermissionRow): Permission {
  return { key: row.key, name: row.name ?? undefined, description: row.description ?? undefined };
}

export function createPermissionRepository(db: SqliteExecutor): PermissionRepository {
  return {
    async register(input: RegisterPermissionInput) {
      const key = assertValidPermissionKey(input.key);
      const name = input.name !== undefined ? sanitizePermissionName(input.name) : undefined;
      const result = await db.query<PermissionRow>(
        `insert into uniora_permissions (key, name, description)
         values (?1, ?2, ?3)
         on conflict (key) do update set name = excluded.name, description = excluded.description
         returning key, name, description`,
        [key, name ?? null, input.description ?? null],
      );
      return toPermission(result.rows[0]!);
    },

    async findByKey(key: string) {
      const result = await db.query<PermissionRow>(
        `select key, name, description from uniora_permissions where key = ?1`,
        [key],
      );
      return result.rows[0] ? toPermission(result.rows[0]) : null;
    },

    async list() {
      const result = await db.query<PermissionRow>(
        `select key, name, description from uniora_permissions order by key asc`,
      );
      return result.rows.map(toPermission);
    },

    async search(options?: SearchPermissionsOptions) {
      const query = options?.query?.trim();
      const result = await db.query<PermissionRow>(
        `select key, name, description
         from uniora_permissions
         where (?1 is null or uniora_ilike(key, ?1) or uniora_ilike(name, ?1))
           and (?2 is null or key > ?2)
           and (?4 is null or exists (
             select 1 from uniora_role_permissions rp where rp.role_id = ?4 and rp.permission_key = uniora_permissions.key
           ))
           and (?5 is null or exists (
             select 1 from uniora_role_permissions rp
             join uniora_membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = ?5 and rp.permission_key = uniora_permissions.key
           ))
         order by key asc
         limit coalesce(?3, -1)`,
        [query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.grantedToRole ?? null, options?.grantedToMember ?? null],
      );
      return result.rows.map(toPermission);
    },

    async count(options?: { query?: string; grantedToRole?: string; grantedToMember?: string }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: number }>(
        `select count(*) as count
         from uniora_permissions
         where (?1 is null or uniora_ilike(key, ?1) or uniora_ilike(name, ?1))
           and (?2 is null or exists (
             select 1 from uniora_role_permissions rp where rp.role_id = ?2 and rp.permission_key = uniora_permissions.key
           ))
           and (?3 is null or exists (
             select 1 from uniora_role_permissions rp
             join uniora_membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = ?3 and rp.permission_key = uniora_permissions.key
           ))`,
        [query ? toLikePattern(query) : null, options?.grantedToRole ?? null, options?.grantedToMember ?? null],
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

    async unregister(key: string) {
      // One WHERE-guarded DELETE, same pattern as the Postgres adapter:
      // "not granted to any role" is decided by the very statement that
      // deletes, never by a read that could go stale before it.
      const result = await db.query(
        `delete from uniora_permissions
         where key = ?1
           and not exists (select 1 from uniora_role_permissions where permission_key = ?1)`,
        [key],
      );
      if (result.rowCount > 0) return;

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
