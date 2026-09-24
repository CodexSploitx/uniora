import type { CreateOwnerRoleInput, CreateRoleInput, Role, RoleRepository, RoleSummary, SearchRolesOptions } from "@uniora/core";
import { RoleError, resolveRoleKey, sanitizeRoleName, sanitizeRolePermissionKeys, assertNonEmptyPermissionKey } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { countByOrganization } from "../pg-counts.js";
import { toLikePattern } from "../pg-like.js";
import { isUniqueViolation, violatedConstraint } from "../pg-errors.js";

interface RoleRow {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  is_owner_role: boolean;
  permission_keys: string[];
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    organizationId: row.organization_id,
    isOwnerRole: row.is_owner_role,
    key: row.key,
    name: row.name,
    permissionKeys: row.permission_keys,
  };
}

const SELECT_ROLE_WITH_PERMISSIONS = `
  select r.id, r.organization_id, r.name, r.key, r.is_owner_role,
         coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permission_keys
  from uniora.roles r
  left join uniora.role_permissions rp on rp.role_id = r.id
`;

interface RoleHeadRow {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  is_owner_role: boolean;
}

function toRoleSummary(row: RoleHeadRow): RoleSummary {
  return { id: row.id, organizationId: row.organization_id, name: row.name, key: row.key, isOwnerRole: row.is_owner_role };
}

/** The role's own columns only — never loads its permission list (which can hold thousands of keys). */
async function findRoleHead(db: Queryable, roleId: string): Promise<RoleSummary | null> {
  const result = await db.query<RoleHeadRow>(
    `select id, organization_id, name, key, is_owner_role from uniora.roles where id = $1`,
    [roleId],
  );
  return result.rows[0] ? toRoleSummary(result.rows[0]) : null;
}

async function findRoleById(db: Queryable, roleId: string): Promise<Role | null> {
  const result = await db.query<RoleRow>(`${SELECT_ROLE_WITH_PERMISSIONS} where r.id = $1 group by r.id`, [roleId]);
  return result.rows[0] ? toRole(result.rows[0]) : null;
}

export function createRoleRepository(db: Queryable): RoleRepository {
  return {
    async create(input: CreateRoleInput) {
      const name = sanitizeRoleName(input.name);
      const key = resolveRoleKey(name, input.key);
      // Validated before the insert (not after) so a malformed
      // permissionKeys entry never leaves a committed, permission-less
      // role behind: this repository isn't wrapped in a transaction when
      // called outside storage.transaction(...), so the role insert below
      // autocommits immediately on the pool.
      const permissionKeys = sanitizeRolePermissionKeys(input.permissionKeys);

      try {
        await db.query(`insert into uniora.roles (id, organization_id, name, key) values ($1, $2, $3, $4)`, [
          input.id,
          input.organizationId,
          name,
          key,
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const constraint = violatedConstraint(error);
          if (constraint === "roles_pkey") {
            throw new RoleError(`A role with id "${input.id}" already exists.`);
          }
          if (constraint === "roles_org_key_key") {
            throw new RoleError(
              input.key !== undefined
                ? `A role with key "${key}" already exists in this organization.`
                : `Could not derive a unique key from this role name — "${key}" is already taken in this organization. Pass an explicit \`key\`.`,
            );
          }
          throw new RoleError(`A role named "${name}" already exists in this organization.`);
        }
        throw error;
      }

      for (const permissionKey of permissionKeys) {
        await db.query(
          `insert into uniora.role_permissions (role_id, permission_key) values ($1, $2) on conflict do nothing`,
          [input.id, permissionKey],
        );
      }

      return {
        id: input.id,
        organizationId: input.organizationId,
        isOwnerRole: false,
        key,
        name,
        permissionKeys,
      };
    },

    async createOwnerRole(input: CreateOwnerRoleInput) {
      try {
        const result = await db.query<RoleRow>(
          `insert into uniora.roles (id, organization_id, name, key, is_owner_role)
           values ($1, $2, 'Owner', 'owner', true)
           returning id, organization_id, name, key, is_owner_role, '{}'::text[] as permission_keys`,
          [input.id, input.organizationId],
        );
        return toRole(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (violatedConstraint(error) === "roles_pkey") {
            throw new RoleError(`A role with id "${input.id}" already exists.`);
          }
          throw new RoleError(`Organization "${input.organizationId}" already has an Owner role.`);
        }
        throw error;
      }
    },

    async findByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<RoleRow>(
        `${SELECT_ROLE_WITH_PERMISSIONS} where r.id = any($1) group by r.id`,
        [ids],
      );
      return result.rows.map(toRole);
    },

    async listByOrganization(organizationId: string) {
      const result = await db.query<RoleRow>(
        `${SELECT_ROLE_WITH_PERMISSIONS} where r.organization_id = $1 group by r.id`,
        [organizationId],
      );
      return result.rows.map(toRole);
    },

    async findSummariesByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<RoleHeadRow>(
        `select id, organization_id, name, key, is_owner_role from uniora.roles where id = any($1::text[])`,
        [ids],
      );
      return result.rows.map(toRoleSummary);
    },

    async search(options: SearchRolesOptions) {
      const query = options.query?.trim();
      const result = await db.query<RoleHeadRow>(
        `select id, organization_id, name, key, is_owner_role
         from uniora.roles
         where organization_id = $1
           and ($2::text is null or name ilike $2 or key ilike $2)
           and ($3::text is null or key > $3)
           and ($5::text is null or exists (select 1 from uniora.membership_roles mr where mr.membership_id = $5 and mr.role_id = roles.id))
           and ($6::text is null or not exists (select 1 from uniora.membership_roles mr where mr.membership_id = $6 and mr.role_id = roles.id))
           and ($7::boolean is null or is_owner_role = $7)
         order by key asc
         limit $4`,
        [options.organizationId, query ? toLikePattern(query) : null, options.after ?? null, options.limit ?? null, options.heldBy ?? null, options.notHeldBy ?? null, options.isOwnerRole ?? null],
      );
      return result.rows.map(toRoleSummary);
    },

    async count(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.roles
         where ($1::text is null or organization_id = $1)
           and ($2::text is null or name ilike $2 or key ilike $2)
           and ($3::text is null or exists (select 1 from uniora.membership_roles mr where mr.membership_id = $3 and mr.role_id = roles.id))
           and ($4::text is null or not exists (select 1 from uniora.membership_roles mr where mr.membership_id = $4 and mr.role_id = roles.id))
           and ($5::boolean is null or is_owner_role = $5)`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.heldBy ?? null, options?.notHeldBy ?? null, options?.isOwnerRole ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async countPermissions(roleIds: string[]) {
      const counts: Record<string, number> = Object.fromEntries(roleIds.map((id) => [id, 0]));
      if (roleIds.length === 0) return counts;
      const result = await db.query<{ role_id: string; count: string }>(
        `select role_id, count(*)::text as count from uniora.role_permissions where role_id = any($1::text[]) group by role_id`,
        [roleIds],
      );
      for (const row of result.rows) counts[row.role_id] = Number(row.count);
      return counts;
    },

    async grantingRoles(membershipId: string, keys: string[], perKey: number) {
      const out: Record<string, { total: number; roles: RoleSummary[] }> = Object.fromEntries(
        keys.map((key) => [key, { total: 0, roles: [] as RoleSummary[] }]),
      );
      if (keys.length === 0) return out;
      // One pass over (membership_roles -> role_permissions) for the page's keys:
      // rows are numbered per permission so a bounded preview and the real
      // total come from the same query.
      const result = await db.query<RoleHeadRow & { permission_key: string; rn: string; total: string }>(
        `select permission_key, id, organization_id, name, key, is_owner_role, rn::text, total::text
         from (
           select rp.permission_key, r.id, r.organization_id, r.name, r.key, r.is_owner_role,
                  row_number() over (partition by rp.permission_key order by r.name, r.id) as rn,
                  count(*) over (partition by rp.permission_key) as total
           from uniora.membership_roles mr
           join uniora.role_permissions rp on rp.role_id = mr.role_id
           join uniora.roles r on r.id = mr.role_id
           where mr.membership_id = $1 and rp.permission_key = any($2::text[])
         ) s
         where rn <= $3
         order by permission_key, rn`,
        [membershipId, keys, perKey],
      );
      for (const row of result.rows) {
        const entry = out[row.permission_key]!;
        entry.total = Number(row.total);
        entry.roles.push(toRoleSummary(row));
      }
      return out;
    },

    async grantedPermissionKeys(roleId: string, keys: string[]) {
      if (keys.length === 0) return [];
      const result = await db.query<{ permission_key: string }>(
        `select permission_key from uniora.role_permissions where role_id = $1 and permission_key = any($2::text[])`,
        [roleId, keys],
      );
      return result.rows.map((row) => row.permission_key);
    },

    async countByOrganization(organizationIds: string[]) {
      return countByOrganization(db, "roles", organizationIds);
    },

    async grantPermission(roleId: string, permissionKey: string) {
      const role = await findRoleHead(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      assertNonEmptyPermissionKey(permissionKey);
      await db.query(
        `insert into uniora.role_permissions (role_id, permission_key) values ($1, $2) on conflict do nothing`,
        [roleId, permissionKey],
      );
    },

    async revokePermission(roleId: string, permissionKey: string) {
      const role = await findRoleHead(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      await db.query(`delete from uniora.role_permissions where role_id = $1 and permission_key = $2`, [
        roleId,
        permissionKey,
      ]);
    },

    async rename(roleId: string, name: string) {
      const role = await findRoleById(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
      const sanitized = sanitizeRoleName(name);
      try {
        await db.query(`update uniora.roles set name = $2 where id = $1`, [roleId, sanitized]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RoleError(`A role named "${sanitized}" already exists in this organization.`);
        }
        throw error;
      }
      return { ...role, name: sanitized };
    },

    async delete(roleId: string) {
      // A single WHERE-guarded statement, not check-then-delete: the
      // "never delete the Owner role" decision must be atomic with the
      // delete itself (uniora-security-engineering §21 Race Conditions),
      // unlike the merely cosmetic grant/revoke/rename guards above, whose
      // worst-case race has no security effect (the Owner bypass in
      // AuthorizationEngine.can() never reads permissionKeys or name).
      const result = await db.query(`delete from uniora.roles where id = $1 and is_owner_role = false`, [roleId]);
      if ((result.rowCount ?? 0) > 0) return;

      const role = await findRoleById(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      throw new RoleError("Cannot delete the protected Owner role.");
    },
  };
}
