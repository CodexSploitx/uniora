import type {
  CloneRoleInput,
  CreateOwnerRoleInput,
  CreateRoleInput,
  DeleteRoleOptions,
  Role,
  RoleRepository,
  RoleSummary,
  SearchRolesOptions,
  SetRolePermissionsResult,
  UpdateRoleInput,
} from "@uniora/core";
import {
  RoleError,
  assertNonEmptyPermissionKey,
  resolveRoleKey,
  sanitizeRoleDescription,
  sanitizeRoleName,
  sanitizeRolePermissionKeys,
} from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { countByOrganization } from "../counts.js";
import { jsonList, parseList } from "../json.js";
import { toLikePattern } from "../like.js";
import { isUniqueViolation, violatedExactly } from "../sqlite-errors.js";

interface RoleRow {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  is_owner_role: number;
  is_system: number;
  description: string | null;
  permission_keys: string;
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    organizationId: row.organization_id,
    isOwnerRole: row.is_owner_role === 1,
    isSystem: row.is_system === 1,
    key: row.key,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    permissionKeys: parseList(row.permission_keys),
  };
}

const SELECT_ROLE_WITH_PERMISSIONS = `
  select r.id, r.organization_id, r.name, r.key, r.is_owner_role, r.is_system, r.description,
         json_group_array(rp.permission_key order by rp.permission_key) filter (where rp.permission_key is not null) as permission_keys
  from uniora_roles r
  left join uniora_role_permissions rp on rp.role_id = r.id
`;

interface RoleHeadRow {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  is_owner_role: number;
  is_system: number;
}

const HEAD_COLUMNS = "id, organization_id, name, key, is_owner_role, is_system";

function toRoleSummary(row: RoleHeadRow): RoleSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    key: row.key,
    isOwnerRole: row.is_owner_role === 1,
    isSystem: row.is_system === 1,
  };
}

/** The role's own columns only — never loads its permission list (which can hold thousands of keys). */
async function findRoleHead(db: SqliteExecutor, roleId: string): Promise<RoleSummary | null> {
  const result = await db.query<RoleHeadRow>(
    `select ${HEAD_COLUMNS} from uniora_roles where id = ?1`,
    [roleId],
  );
  return result.rows[0] ? toRoleSummary(result.rows[0]) : null;
}

async function findRoleById(db: SqliteExecutor, roleId: string): Promise<Role | null> {
  const result = await db.query<RoleRow>(`${SELECT_ROLE_WITH_PERMISSIONS} where r.id = ?1 group by r.id`, [roleId]);
  return result.rows[0] ? toRole(result.rows[0]) : null;
}

export function createRoleRepository(db: SqliteExecutor): RoleRepository {
  const repository: RoleRepository = {
    async create(input: CreateRoleInput) {
      const name = sanitizeRoleName(input.name);
      const key = resolveRoleKey(name, input.key);
      // Validated before anything is written, and the writes below run as ONE
      // atomic unit: a malformed permissionKeys entry (or a failure halfway)
      // never leaves a committed, permission-less role behind.
      const permissionKeys = sanitizeRolePermissionKeys(input.permissionKeys);
      const description = sanitizeRoleDescription(input.description);

      await db.atomic(async () => {
        try {
          await db.query(`insert into uniora_roles (id, organization_id, name, key, is_system, description) values (?1, ?2, ?3, ?4, ?5, ?6)`, [
            input.id,
            input.organizationId,
            name,
            key,
            input.isSystem === true ? 1 : 0,
            description ?? null,
          ]);
        } catch (error) {
          if (isUniqueViolation(error)) {
            if (violatedExactly(error, ["uniora_roles.id"])) {
              throw new RoleError(`A role with id "${input.id}" already exists.`);
            }
            if (violatedExactly(error, ["uniora_roles.organization_id", "uniora_roles.key"])) {
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
            `insert into uniora_role_permissions (role_id, permission_key) values (?1, ?2) on conflict do nothing`,
            [input.id, permissionKey],
          );
        }
      });

      return {
        id: input.id,
        organizationId: input.organizationId,
        isOwnerRole: false,
        isSystem: input.isSystem === true,
        key,
        name,
        ...(description !== undefined ? { description } : {}),
        permissionKeys,
      };
    },

    async createOwnerRole(input: CreateOwnerRoleInput) {
      try {
        const result = await db.query<RoleHeadRow>(
          `insert into uniora_roles (id, organization_id, name, key, is_owner_role)
           values (?1, ?2, 'Owner', 'owner', 1)
           returning ${HEAD_COLUMNS}, null as description`,
          [input.id, input.organizationId],
        );
        return toRole({ ...result.rows[0]!, description: null, permission_keys: "[]" });
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (violatedExactly(error, ["uniora_roles.id"])) {
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
        `${SELECT_ROLE_WITH_PERMISSIONS} where r.id in (select value from json_each(?1)) group by r.id`,
        [jsonList(ids)],
      );
      return result.rows.map(toRole);
    },

    async listByOrganization(organizationId: string) {
      const result = await db.query<RoleRow>(
        `${SELECT_ROLE_WITH_PERMISSIONS} where r.organization_id = ?1 group by r.id`,
        [organizationId],
      );
      return result.rows.map(toRole);
    },

    async findSummariesByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<RoleHeadRow>(
        `select ${HEAD_COLUMNS} from uniora_roles where id in (select value from json_each(?1))`,
        [jsonList(ids)],
      );
      return result.rows.map(toRoleSummary);
    },

    async search(options: SearchRolesOptions) {
      const query = options.query?.trim();
      const result = await db.query<RoleHeadRow>(
        `select ${HEAD_COLUMNS}
         from uniora_roles
         where organization_id = ?1
           and (?2 is null or uniora_ilike(name, ?2) or uniora_ilike(key, ?2))
           and (?3 is null or key > ?3)
           and (?5 is null or exists (select 1 from uniora_membership_roles mr where mr.membership_id = ?5 and mr.role_id = uniora_roles.id))
           and (?6 is null or not exists (select 1 from uniora_membership_roles mr where mr.membership_id = ?6 and mr.role_id = uniora_roles.id))
           and (?7 is null or is_owner_role = ?7)
           and (?8 is null or is_system = ?8)
         order by key asc
         limit coalesce(?4, -1)`,
        [options.organizationId, query ? toLikePattern(query) : null, options.after ?? null, options.limit ?? null, options.heldBy ?? null, options.notHeldBy ?? null, options.isOwnerRole ?? null, options.isSystem ?? null],
      );
      return result.rows.map(toRoleSummary);
    },

    async count(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean; isSystem?: boolean }) {
      const query = options?.query?.trim();
      const result = await db.query<{ count: number }>(
        `select count(*) as count
         from uniora_roles
         where (?1 is null or organization_id = ?1)
           and (?2 is null or uniora_ilike(name, ?2) or uniora_ilike(key, ?2))
           and (?3 is null or exists (select 1 from uniora_membership_roles mr where mr.membership_id = ?3 and mr.role_id = uniora_roles.id))
           and (?4 is null or not exists (select 1 from uniora_membership_roles mr where mr.membership_id = ?4 and mr.role_id = uniora_roles.id))
           and (?5 is null or is_owner_role = ?5)
           and (?6 is null or is_system = ?6)`,
        [options?.organizationId ?? null, query ? toLikePattern(query) : null, options?.heldBy ?? null, options?.notHeldBy ?? null, options?.isOwnerRole ?? null, options?.isSystem ?? null],
      );
      return Number(result.rows[0]!.count);
    },

    async countPermissions(roleIds: string[]) {
      const counts: Record<string, number> = Object.fromEntries(roleIds.map((id) => [id, 0]));
      if (roleIds.length === 0) return counts;
      const result = await db.query<{ role_id: string; count: number }>(
        `select role_id, count(*) as count from uniora_role_permissions where role_id in (select value from json_each(?1)) group by role_id`,
        [jsonList(roleIds)],
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
      const result = await db.query<RoleHeadRow & { permission_key: string; rn: number; total: number }>(
        `select permission_key, id, organization_id, name, key, is_owner_role, is_system, rn, total
         from (
           select rp.permission_key, r.id, r.organization_id, r.name, r.key, r.is_owner_role, r.is_system,
                  row_number() over (partition by rp.permission_key order by r.name, r.id) as rn,
                  count(*) over (partition by rp.permission_key) as total
           from uniora_membership_roles mr
           join uniora_role_permissions rp on rp.role_id = mr.role_id
           join uniora_roles r on r.id = mr.role_id
           where mr.membership_id = ?1 and rp.permission_key in (select value from json_each(?2))
         ) s
         where rn <= ?3
         order by permission_key, rn`,
        [membershipId, jsonList(keys), perKey],
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
        `select permission_key from uniora_role_permissions where role_id = ?1 and permission_key in (select value from json_each(?2))`,
        [roleId, jsonList(keys)],
      );
      return result.rows.map((row) => row.permission_key);
    },

    async countByOrganization(organizationIds: string[]) {
      return countByOrganization(db, "roles", organizationIds);
    },

    async grantPermission(roleId: string, permissionKey: string) {
      await db.atomic(async () => {
        const role = await findRoleHead(db, roleId);
        if (!role) throw new RoleError(`Role not found: ${roleId}`);
        if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
        assertNonEmptyPermissionKey(permissionKey);
        await db.query(
          `insert into uniora_role_permissions (role_id, permission_key) values (?1, ?2) on conflict do nothing`,
          [roleId, permissionKey],
        );
      });
    },

    async revokePermission(roleId: string, permissionKey: string) {
      await db.atomic(async () => {
        const role = await findRoleHead(db, roleId);
        if (!role) throw new RoleError(`Role not found: ${roleId}`);
        if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
        await db.query(`delete from uniora_role_permissions where role_id = ?1 and permission_key = ?2`, [
          roleId,
          permissionKey,
        ]);
      });
    },

    async rename(roleId: string, name: string) {
      return db.atomic(async () => {
        const role = await findRoleById(db, roleId);
        if (!role) throw new RoleError(`Role not found: ${roleId}`);
        if (role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
        if (role.isSystem) throw new RoleError("Cannot rename a system role.", "role_system_protected");
        const sanitized = sanitizeRoleName(name);
        try {
          await db.query(`update uniora_roles set name = ?2 where id = ?1`, [roleId, sanitized]);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new RoleError(`A role named "${sanitized}" already exists in this organization.`);
          }
          throw error;
        }
        return { ...role, name: sanitized };
      });
    },

    async update(roleId: string, input: UpdateRoleInput) {
      if (input.name === undefined && input.description === undefined) {
        throw new RoleError("Pass a name and/or a description to update.", "role_update_empty");
      }
      const name = input.name === undefined ? null : sanitizeRoleName(input.name);
      const setDescription = input.description !== undefined;
      const description = setDescription ? (sanitizeRoleDescription(input.description) ?? null) : null;
      return db.atomic(async () => {
        const role = await findRoleHead(db, roleId);
        if (!role) throw new RoleError(`Role not found: ${roleId}`);
        if (name !== null && role.isOwnerRole) throw new RoleError("Cannot rename the protected Owner role.");
        if (name !== null && role.isSystem) throw new RoleError("Cannot rename a system role.", "role_system_protected");
        if (setDescription && name === null && role.isOwnerRole) throw new RoleError("Cannot modify the protected Owner role.");
        try {
          await db.query(
            `update uniora_roles set name = coalesce(?2, name), description = case when ?3 then ?4 else description end where id = ?1`,
            [roleId, name, setDescription ? 1 : 0, description],
          );
        } catch (error) {
          if (isUniqueViolation(error)) throw new RoleError(`A role named "${name}" already exists in this organization.`);
          throw error;
        }
        return (await findRoleById(db, roleId))!;
      });
    },

    async setPermissions(roleId: string, permissionKeys: string[]): Promise<SetRolePermissionsResult> {
      const wanted = sanitizeRolePermissionKeys(permissionKeys);
      return db.atomic(async () => {
        const role = await findRoleHead(db, roleId);
        if (!role) throw new RoleError(`Role not found: ${roleId}`);
        if (role.isOwnerRole) throw new RoleError("Cannot modify permissions on the protected Owner role.");
        const known = await db.query<{ key: string }>(
          `select key from uniora_permissions where key in (select value from json_each(?1))`,
          [jsonList(wanted)],
        );
        if (known.rows.length !== wanted.length) {
          throw new RoleError("One or more permissions are not registered.", "role_permission_invalid");
        }
        const current = await db.query<{ permission_key: string }>(
          `select permission_key from uniora_role_permissions where role_id = ?1 order by permission_key`,
          [roleId],
        );
        const had = new Set(current.rows.map((row) => row.permission_key));
        const wantedSet = new Set(wanted);
        const granted = wanted.filter((key) => !had.has(key)).sort();
        const revoked = [...had].filter((key) => !wantedSet.has(key)).sort();
        if (revoked.length > 0) {
          await db.query(`delete from uniora_role_permissions where role_id = ?1 and permission_key in (select value from json_each(?2))`, [
            roleId,
            jsonList(revoked),
          ]);
        }
        if (granted.length > 0) {
          await db.query(
            `insert into uniora_role_permissions (role_id, permission_key) select ?1, value from json_each(?2) where true on conflict do nothing`,
            [roleId, jsonList(granted)],
          );
        }
        return { granted, revoked };
      });
    },

    async clone(roleId: string, input: CloneRoleInput) {
      return db.atomic(async () => {
        const source = await findRoleById(db, roleId);
        if (!source) throw new RoleError(`Role not found: ${roleId}`);
        if (source.isOwnerRole) {
          throw new RoleError("The protected Owner role cannot be cloned: its power is a flag, not a list.", "owner_role_protected");
        }
        const description = sanitizeRoleDescription(input.description) ?? source.description;
        return repository.create({
          id: input.id,
          organizationId: input.organizationId ?? source.organizationId,
          name: input.name,
          ...(input.key !== undefined ? { key: input.key } : {}),
          permissionKeys: source.permissionKeys,
          ...(description !== undefined ? { description } : {}),
        });
      });
    },

    async delete(roleId: string, options?: DeleteRoleOptions) {
      const policy = options?.members ?? "detach";
      await db.atomic(async () => {
        const role = await findRoleHead(db, roleId);
        if (!role) throw new RoleError(`Role not found: ${roleId}`);
        if (role.isOwnerRole) throw new RoleError("Cannot delete the protected Owner role.");
        if (role.isSystem) throw new RoleError("Cannot delete a system role.", "role_system_protected");
        if (policy === "reject") {
          const held = await db.query(`select 1 from uniora_membership_roles where role_id = ?1 limit 1`, [roleId]);
          if (held.rows.length > 0) throw new RoleError("The role is still held by at least one membership.", "role_in_use");
        } else if (typeof policy === "object") {
          const target = await findRoleHead(db, policy.reassignTo);
          if (!target || target.organizationId !== role.organizationId || target.isOwnerRole || target.id === roleId) {
            throw new RoleError(
              "reassignTo must be another role of the same organization and not the Owner role.",
              "role_reassign_invalid",
            );
          }
          await db.query(
            `insert into uniora_membership_roles (membership_id, role_id)
             select membership_id, ?2 from uniora_membership_roles where role_id = ?1 on conflict do nothing`,
            [roleId, target.id],
          );
        }
        await db.query(`delete from uniora_roles where id = ?1 and is_owner_role = 0 and is_system = 0`, [roleId]);
      });
    },
  };
  return repository;
}
