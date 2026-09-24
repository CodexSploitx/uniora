import type { Permission, PermissionRepository, RegisterPermissionInput, SearchPermissionsOptions } from "@uniora/core";
import { PermissionError, assertValidPermissionKey, sanitizePermissionName } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { toLikePattern } from "../pg-like.js";

interface PermissionRow {
  key: string;
  name: string | null;
  description: string | null;
}

function toPermission(row: PermissionRow): Permission {
  return { key: row.key, name: row.name ?? undefined, description: row.description ?? undefined };
}

export function createPermissionRepository(db: Queryable): PermissionRepository {
  return {
    async register(input: RegisterPermissionInput) {
      const key = assertValidPermissionKey(input.key);
      const name = input.name !== undefined ? sanitizePermissionName(input.name) : undefined;
      const result = await db.query<PermissionRow>(
        `insert into uniora.permissions (key, name, description)
         values ($1, $2, $3)
         on conflict (key) do update set name = excluded.name, description = excluded.description
         returning key, name, description`,
        [key, name ?? null, input.description ?? null],
      );
      return toPermission(result.rows[0]!);
    },

    async findByKey(key: string) {
      const result = await db.query<PermissionRow>(
        `select key, name, description from uniora.permissions where key = $1`,
        [key],
      );
      return result.rows[0] ? toPermission(result.rows[0]) : null;
    },

    async list() {
      const result = await db.query<PermissionRow>(
        `select key, name, description from uniora.permissions order by key asc`,
      );
      return result.rows.map(toPermission);
    },

    async search(options?: SearchPermissionsOptions) {
      const query = options?.query?.trim();
      const result = await db.query<PermissionRow>(
        `select key, name, description
         from uniora.permissions
         where ($1::text is null or key ilike $1 or name ilike $1)
           and ($2::text is null or key > $2)
           and ($4::text is null or exists (
             select 1 from uniora.role_permissions rp where rp.role_id = $4 and rp.permission_key = key
           ))
           and ($5::text is null or exists (
             select 1 from uniora.role_permissions rp
             join uniora.membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = $5 and rp.permission_key = permissions.key
           ))
         order by key asc
         limit $3`,
        [query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.grantedToRole ?? null, options?.grantedToMember ?? null],
      );
      return result.rows.map(toPermission);
    },

    async count(options?: { query?: string; grantedToRole?: string; grantedToMember?: string }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.permissions
         where ($1::text is null or key ilike $1 or name ilike $1)
           and ($2::text is null or exists (
             select 1 from uniora.role_permissions rp where rp.role_id = $2 and rp.permission_key = key
           ))
           and ($3::text is null or exists (
             select 1 from uniora.role_permissions rp
             join uniora.membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = $3 and rp.permission_key = permissions.key
           ))`,
        [query ? toLikePattern(query) : null, options?.grantedToRole ?? null, options?.grantedToMember ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async countRoleGrants(keys: string[]) {
      const counts: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
      if (keys.length === 0) return counts;
      const result = await db.query<{ permission_key: string; count: string }>(
        `select permission_key, count(*)::text as count
         from uniora.role_permissions
         where permission_key = any($1::text[])
         group by permission_key`,
        [keys],
      );
      for (const row of result.rows) counts[row.permission_key] = Number(row.count);
      return counts;
    },

    async unregister(key: string) {
      // Atomic WHERE-guarded DELETE, same pattern as MembershipRepository's
      // Owner protection (docs/postgres.md): "not granted to any role" must
      // be decided in the same statement as the delete, otherwise a
      // concurrent grantPermission() could race between the check and the
      // delete and leave a role pointing at a permission_key that no
      // longer exists in the catalog.
      const result = await db.query(
        `delete from uniora.permissions
         where key = $1
           and not exists (select 1 from uniora.role_permissions where permission_key = $1)`,
        [key],
      );
      if ((result.rowCount ?? 0) > 0) return;

      const stillGranted = await db.query(
        `select 1 from uniora.role_permissions where permission_key = $1 limit 1`,
        [key],
      );
      if ((stillGranted.rowCount ?? 0) > 0) {
        throw new PermissionError(
          `Cannot unregister permission "${key}": it is still granted to at least one role. Revoke it everywhere first.`,
        );
      }
      throw new PermissionError(`Permission not found: ${key}`);
    },
  };
}
