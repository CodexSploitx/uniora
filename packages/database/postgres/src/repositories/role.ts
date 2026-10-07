import type {
  CloneRoleInput,
  CreateOwnerRoleInput,
  CreateRoleInput,
  DeleteRoleOptions,
  Role,
  RoleRepository,
  RoleSummary,
  SearchRolesOptions,
  SetRolePermissionsOptions,
  SetRolePermissionsResult,
  UpdateRoleInput,
} from "@uniora/core";
import {
  RoleError,
  assertExpectedVersion,
  assertNonEmptyPermissionKey,
  normalizeRoleName,
  resolveRoleKey,
  sanitizeRoleDescription,
  sanitizeRoleName,
  sanitizeRolePermissionKeys,
} from "@uniora/core";
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
  is_system: boolean;
  description: string | null;
  permission_keys: string[];
  version: number;
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    organizationId: row.organization_id,
    isOwnerRole: row.is_owner_role,
    isSystem: row.is_system,
    key: row.key,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    permissionKeys: row.permission_keys,
    version: row.version,
  };
}

const SELECT_ROLE_WITH_PERMISSIONS = `
  select r.id, r.organization_id, r.name, r.key, r.is_owner_role, r.is_system, r.description, r.version,
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
  is_system: boolean;
}

const HEAD_COLUMNS = "id, organization_id, name, key, is_owner_role, is_system";

function toRoleSummary(row: RoleHeadRow): RoleSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    key: row.key,
    isOwnerRole: row.is_owner_role,
    isSystem: row.is_system,
  };
}

/** The role's own columns only — never loads its permission list (which can hold thousands of keys). */
async function findRoleHead(db: Queryable, roleId: string): Promise<RoleSummary | null> {
  const result = await db.query<RoleHeadRow>(
    `select ${HEAD_COLUMNS} from uniora.roles where id = $1`,
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
      const description = sanitizeRoleDescription(input.description);

      try {
        await db.query(`insert into uniora.roles (id, organization_id, name, name_normalized, key, is_system, description) values ($1, $2, $3, $4, $5, $6, $7)`, [
          input.id,
          input.organizationId,
          name,
          normalizeRoleName(name),
          key,
          input.isSystem === true,
          description ?? null,
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
        isSystem: input.isSystem === true,
        key,
        name,
        ...(description !== undefined ? { description } : {}),
        permissionKeys,
        version: 1,
      };
    },

    async createOwnerRole(input: CreateOwnerRoleInput) {
      try {
        const result = await db.query<RoleRow>(
          `insert into uniora.roles (id, organization_id, name, name_normalized, key, is_owner_role)
           values ($1, $2, 'Owner', 'owner', 'owner', true)
           returning id, organization_id, name, key, is_owner_role, is_system, description, version, '{}'::text[] as permission_keys`,
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
        `select ${HEAD_COLUMNS} from uniora.roles where id = any($1::text[])`,
        [ids],
      );
      return result.rows.map(toRoleSummary);
    },

    async search(options: SearchRolesOptions) {
      const query = options.query?.trim();
      const result = await db.query<RoleHeadRow>(
        `select ${HEAD_COLUMNS}
         from uniora.roles
         where organization_id = $1
           and ($2::text is null or name ilike $2 or key ilike $2)
           and ($3::text is null or key > $3)
           and ($5::text is null or exists (select 1 from uniora.membership_roles mr where mr.membership_id = $5 and mr.role_id = roles.id))
           and ($6::text is null or not exists (select 1 from uniora.membership_roles mr where mr.membership_id = $6 and mr.role_id = roles.id))
           and ($7::boolean is null or is_owner_role = $7)
           and ($8::boolean is null or is_system = $8)
         order by key asc
         limit $4`,
        [options.organizationId, query ? toLikePattern(query) : null, options.after ?? null, options.limit ?? null, options.heldBy ?? null, options.notHeldBy ?? null, options.isOwnerRole ?? null, options.isSystem ?? null],
      );
      return result.rows.map(toRoleSummary);
    },

    async count(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean; isSystem?: boolean }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from uniora.roles
         where ($1::text is null or organization_id = $1)
           and ($2::text is null or name ilike $2 or key ilike $2)
           and ($3::text is null or exists (select 1 from uniora.membership_roles mr where mr.membership_id = $3 and mr.role_id = roles.id))
           and ($4::text is null or not exists (select 1 from uniora.membership_roles mr where mr.membership_id = $4 and mr.role_id = roles.id))
           and ($5::boolean is null or is_owner_role = $5)
           and ($6::boolean is null or is_system = $6)`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.heldBy ?? null, options?.notHeldBy ?? null, options?.isOwnerRole ?? null, options?.isSystem ?? null],
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
        `select permission_key, id, organization_id, name, key, is_owner_role, is_system, rn::text, total::text
         from (
           select rp.permission_key, r.id, r.organization_id, r.name, r.key, r.is_owner_role, r.is_system,
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
      // One statement: the version only goes up when the permission was really added.
      await db.query(
        `with added as (
           insert into uniora.role_permissions (role_id, permission_key) values ($1, $2) on conflict do nothing returning 1
         )
         update uniora.roles set version = version + 1 where id = $1 and exists (select 1 from added)`,
        [roleId, permissionKey],
      );
    },

    async revokePermission(roleId: string, permissionKey: string) {
      const role = await findRoleHead(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      await db.query(
        `with removed as (
           delete from uniora.role_permissions where role_id = $1 and permission_key = $2 returning 1
         )
         update uniora.roles set version = version + 1 where id = $1 and exists (select 1 from removed)`,
        [roleId, permissionKey],
      );
    },

    async rename(roleId: string, name: string) {
      const role = await findRoleById(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
      if (role.isSystem) throw new RoleError("Cannot rename a system role.", "role_system_protected");
      const sanitized = sanitizeRoleName(name);
      try {
        await db.query(`update uniora.roles set name = $2, name_normalized = $3, version = version + 1 where id = $1`, [roleId, sanitized, normalizeRoleName(sanitized)]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RoleError(`A role named "${sanitized}" already exists in this organization.`);
        }
        throw error;
      }
      return { ...role, name: sanitized, version: role.version + 1 };
    },

    async update(roleId: string, input: UpdateRoleInput) {
      if (input.name === undefined && input.description === undefined) {
        throw new RoleError("Pass a name and/or a description to update.", "role_update_empty");
      }
      const name = input.name === undefined ? null : sanitizeRoleName(input.name);
      const setDescription = input.description !== undefined;
      const description = setDescription ? (sanitizeRoleDescription(input.description) ?? null) : null;
      const expectedVersion = assertExpectedVersion(input.expectedVersion) ?? null;
      const role = await findRoleHead(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (name !== null && role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
      if (name !== null && role.isSystem) throw new RoleError("Cannot rename a system role.", "role_system_protected");
      if (setDescription && name === null && role.isOwnerRole) throw new RoleError("Cannot modify the protected Owner role.");
      try {
        const changed = await db.query(
          `update uniora.roles set name = coalesce($2, name), name_normalized = coalesce($6, name_normalized), description = case when $3::boolean then $4 else description end,
             version = version + 1
           where id = $1 and not is_owner_role and (not is_system or $2::text is null) and ($5::integer is null or version = $5)`,
          [roleId, name, setDescription, description, expectedVersion, name === null ? null : normalizeRoleName(name)],
        );
        if (changed.rowCount === 0 && expectedVersion !== null) {
          throw new RoleError("The role changed since it was read.", "role_version_conflict");
        }
      } catch (error) {
        if (isUniqueViolation(error)) throw new RoleError(`A role named "${name}" already exists in this organization.`);
        throw error;
      }
      const updated = await findRoleById(db, roleId);
      if (!updated) throw new RoleError(`Role not found: ${roleId}`);
      return updated;
    },

    async setPermissions(roleId: string, permissionKeys: string[], options?: SetRolePermissionsOptions): Promise<SetRolePermissionsResult> {
      const wanted = sanitizeRolePermissionKeys(permissionKeys);
      const expectedVersion = assertExpectedVersion(options?.expectedVersion) ?? null;
      const role = await findRoleHead(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
      try {
        // ONE statement: the removals and the additions are applied together or not at all (a failed foreign key,
        // i.e. an unregistered key, rolls the whole statement back).
        // `locked` takes the role row (and checks the version) first; nothing else runs when it is empty. The version
        // goes up only when something was really granted or revoked.
        const result = await db.query<{ granted: string[] | null; revoked: string[] | null; matched: boolean }>(
          `with locked as (
             select id from uniora.roles where id = $1 and ($3::integer is null or version = $3) for update
           ),
           revoked as (
             delete from uniora.role_permissions rp
             where rp.role_id = $1 and rp.permission_key <> all($2::text[]) and exists (select 1 from locked)
             returning rp.permission_key
           ),
           granted as (
             insert into uniora.role_permissions (role_id, permission_key)
             select $1, k from unnest($2::text[]) as k where exists (select 1 from locked)
             on conflict do nothing
             returning permission_key
           ),
           bumped as (
             update uniora.roles set version = version + 1
             where id = $1 and (exists (select 1 from granted) or exists (select 1 from revoked))
             returning 1
           )
           select (select array_agg(permission_key order by permission_key) from granted) as granted,
                  (select array_agg(permission_key order by permission_key) from revoked) as revoked,
                  exists (select 1 from locked) as matched`,
          [roleId, wanted, expectedVersion],
        );
        const row = result.rows[0];
        if (row && !row.matched) throw new RoleError("The role changed since it was read.", "role_version_conflict");
        return { granted: row?.granted ?? [], revoked: row?.revoked ?? [] };
      } catch (error) {
        if ((error as { code?: string }).code === "23503") {
          throw new RoleError("One or more permissions are not registered.", "role_permission_invalid");
        }
        throw error;
      }
    },

    async clone(roleId: string, input: CloneRoleInput) {
      const source = await findRoleById(db, roleId);
      if (!source) throw new RoleError(`Role not found: ${roleId}`);
      if (source.isOwnerRole) {
        throw new RoleError("The protected Owner role cannot be cloned: its power is a flag, not a list.", "owner_role_protected");
      }
      const name = sanitizeRoleName(input.name);
      const key = resolveRoleKey(name, input.key);
      const organizationId = input.organizationId ?? source.organizationId;
      const description = sanitizeRoleDescription(input.description) ?? source.description;
      try {
        // Role and permission copy in one statement, so a clone is never left without its permissions.
        await db.query(
          `with new_role as (
             insert into uniora.roles (id, organization_id, name, name_normalized, key, description) values ($1, $2, $3, $7, $4, $5) returning id
           )
           insert into uniora.role_permissions (role_id, permission_key)
           select $1, rp.permission_key from uniora.role_permissions rp, new_role where rp.role_id = $6`,
          [input.id, organizationId, name, key, description ?? null, roleId, normalizeRoleName(name)],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          const constraint = violatedConstraint(error);
          if (constraint === "roles_pkey") throw new RoleError(`A role with id "${input.id}" already exists.`);
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
      return {
        id: input.id,
        organizationId,
        isOwnerRole: false,
        isSystem: false,
        key,
        name,
        ...(description !== undefined ? { description } : {}),
        permissionKeys: [...source.permissionKeys],
        version: 1,
      };
    },

    async delete(roleId: string, options?: DeleteRoleOptions) {
      const policy = options?.members ?? "detach";
      // Each branch is a single WHERE-guarded statement, not check-then-delete: "never delete the Owner or a system
      // role" must be atomic with the delete itself (uniora-security-engineering §21 Race Conditions).
      if (typeof policy === "object") {
        const result = await db.query(
          `with target as (
             select id, organization_id from uniora.roles where id = $1 and not is_owner_role and not is_system
           ),
           dest as (
             select r.id from uniora.roles r, target t
             where r.id = $2 and r.organization_id = t.organization_id and not r.is_owner_role and r.id <> t.id
           ),
           moved as (
             insert into uniora.membership_roles (membership_id, role_id)
             select mr.membership_id, $2 from uniora.membership_roles mr
             where mr.role_id = $1 and exists (select 1 from dest) and exists (select 1 from target)
             on conflict do nothing
             returning 1
           )
           delete from uniora.roles where id = $1 and exists (select 1 from target) and exists (select 1 from dest)`,
          [roleId, policy.reassignTo],
        );
        if ((result.rowCount ?? 0) > 0) return;
      } else if (policy === "reject") {
        const result = await db.query(
          `delete from uniora.roles r
           where r.id = $1 and not r.is_owner_role and not r.is_system
             and not exists (select 1 from uniora.membership_roles mr where mr.role_id = r.id)`,
          [roleId],
        );
        if ((result.rowCount ?? 0) > 0) return;
      } else {
        const result = await db.query(`delete from uniora.roles where id = $1 and not is_owner_role and not is_system`, [roleId]);
        if ((result.rowCount ?? 0) > 0) return;
      }

      const role = await findRoleHead(db, roleId);
      if (!role) throw new RoleError(`Role not found: ${roleId}`);
      if (role.isOwnerRole) throw new RoleError("Cannot delete the protected Owner role.");
      if (role.isSystem) throw new RoleError("Cannot delete a system role.", "role_system_protected");
      if (typeof policy === "object") {
        throw new RoleError(
          "reassignTo must be another role of the same organization and not the Owner role.",
          "role_reassign_invalid",
        );
      }
      throw new RoleError("The role is still held by at least one membership.", "role_in_use");
    },
  };
}
