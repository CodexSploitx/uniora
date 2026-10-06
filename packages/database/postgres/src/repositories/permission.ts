import type { Permission, PermissionRepository, RegisterPermissionInput, SearchPermissionsOptions } from "@uniora/core";
import {
  PermissionError,
  assertValidImplications,
  assertValidPermissionKey,
  sanitizeImplies,
  sanitizePermissionGroup,
  sanitizePermissionName,
} from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { toLikePattern } from "../pg-like.js";

interface PermissionRow {
  key: string;
  name: string | null;
  description: string | null;
  group_key: string | null;
  implies: string[];
}

const COLUMNS = `p.key, p.name, p.description, p.group_key,
  coalesce((select array_agg(pi.implied_key order by pi.implied_key) from uniora.permission_implications pi where pi.permission_key = p.key), '{}') as implies`;

function toPermission(row: PermissionRow): Permission {
  return {
    key: row.key,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    ...(row.group_key !== null ? { group: row.group_key } : {}),
    ...(row.implies.length > 0 ? { implies: row.implies } : {}),
  };
}

export function createPermissionRepository(db: Queryable): PermissionRepository {
  return {
    async register(input: RegisterPermissionInput) {
      const key = assertValidPermissionKey(input.key);
      const name = input.name !== undefined ? sanitizePermissionName(input.name) : undefined;
      const group = sanitizePermissionGroup(input.group);
      const implies = sanitizeImplies(input.implies);
      if (implies.length > 0) {
        const rows = await db.query<{ permission_key: string; implied_key: string | null }>(
          `select p.key as permission_key, pi.implied_key
           from uniora.permissions p left join uniora.permission_implications pi on pi.permission_key = p.key`,
        );
        const graph = new Map<string, string[]>();
        for (const row of rows.rows) {
          const list = graph.get(row.permission_key) ?? [];
          if (row.implied_key !== null) list.push(row.implied_key);
          graph.set(row.permission_key, list);
        }
        assertValidImplications(graph, key, implies);
      }
      try {
        // ONE statement: the permission and its implications change together or not at all.
        await db.query(
          `with upserted as (
             insert into uniora.permissions (key, name, description, group_key)
             values ($1, $2, $3, $4)
             on conflict (key) do update set name = excluded.name, description = excluded.description, group_key = excluded.group_key
             returning key
           ),
           removed as (
             delete from uniora.permission_implications
             where permission_key = $1 and implied_key <> all($5::text[])
           )
           insert into uniora.permission_implications (permission_key, implied_key)
           select u.key, k from upserted u, unnest($5::text[]) as k
           on conflict do nothing`,
          [key, name ?? null, input.description ?? null, group ?? null, implies],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23503") {
          throw new PermissionError("One or more implied permissions are not registered.", "permission_implication_invalid");
        }
        throw error;
      }
      const result = await db.query<PermissionRow>(`select ${COLUMNS} from uniora.permissions p where p.key = $1`, [key]);
      return toPermission(result.rows[0]!);
    },

    async findByKey(key: string) {
      const result = await db.query<PermissionRow>(
        `select ${COLUMNS} from uniora.permissions p where p.key = $1`,
        [key],
      );
      return result.rows[0] ? toPermission(result.rows[0]) : null;
    },

    async list() {
      const result = await db.query<PermissionRow>(
        `select ${COLUMNS} from uniora.permissions p order by p.key asc`,
      );
      return result.rows.map(toPermission);
    },

    async search(options?: SearchPermissionsOptions) {
      const query = options?.query?.trim();
      const result = await db.query<PermissionRow>(
        `select ${COLUMNS}
         from uniora.permissions p
         where ($1::text is null or p.key ilike $1 or p.name ilike $1)
           and ($2::text is null or p.key > $2)
           and ($4::text is null or exists (
             select 1 from uniora.role_permissions rp where rp.role_id = $4 and rp.permission_key = p.key
           ))
           and ($5::text is null or exists (
             select 1 from uniora.role_permissions rp
             join uniora.membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = $5 and rp.permission_key = p.key
           ))
           and ($6::text is null or p.group_key = $6)
         order by p.key asc
         limit $3`,
        [query ? toLikePattern(query) : null, options?.after ?? null, options?.limit ?? null, options?.grantedToRole ?? null, options?.grantedToMember ?? null, options?.group ?? null],
      );
      return result.rows.map(toPermission);
    },

    async count(options?: { query?: string; group?: string; grantedToRole?: string; grantedToMember?: string }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.permissions p
         where ($1::text is null or p.key ilike $1 or p.name ilike $1)
           and ($2::text is null or exists (
             select 1 from uniora.role_permissions rp where rp.role_id = $2 and rp.permission_key = p.key
           ))
           and ($3::text is null or exists (
             select 1 from uniora.role_permissions rp
             join uniora.membership_roles mr on mr.role_id = rp.role_id
             where mr.membership_id = $3 and rp.permission_key = p.key
           ))
           and ($4::text is null or p.group_key = $4)`,
        [query ? toLikePattern(query) : null, options?.grantedToRole ?? null, options?.grantedToMember ?? null, options?.group ?? null],
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

    async impliedBy(key: string) {
      const result = await db.query<{ key: string }>(
        `with recursive up(key, depth) as (
           select permission_key, 1 from uniora.permission_implications where implied_key = $1
           union
           select pi.permission_key, up.depth + 1
           from uniora.permission_implications pi join up on pi.implied_key = up.key
           where up.depth < 9
         )
         select distinct key from up where key <> $1 order by key`,
        [key],
      );
      return result.rows.map((row) => row.key);
    },

    async expand(keys: string[]) {
      if (keys.length === 0) return [];
      const result = await db.query<{ key: string }>(
        `with recursive down(key, depth) as (
           select k, 0 from unnest($1::text[]) as k
           union
           select pi.implied_key, down.depth + 1
           from uniora.permission_implications pi join down on pi.permission_key = down.key
           where down.depth < 9
         )
         select distinct key from down order by key`,
        [keys],
      );
      return result.rows.map((row) => row.key);
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
           and not exists (select 1 from uniora.role_permissions where permission_key = $1)
           and not exists (select 1 from uniora.permission_implications where implied_key = $1)`,
        [key],
      );
      if ((result.rowCount ?? 0) > 0) return;

      const dependents = await db.query(`select 1 from uniora.permission_implications where implied_key = $1 limit 1`, [key]);
      if ((dependents.rowCount ?? 0) > 0) {
        throw new PermissionError(
          `Cannot unregister permission "${key}": another permission still implies it. Change that one first.`,
          "permission_has_dependents",
        );
      }

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
