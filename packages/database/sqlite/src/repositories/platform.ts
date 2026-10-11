import type {
  AddPlatformMemberInput,
  CreatePlatformRoleInput,
  Identity,
  PlatformMember,
  PlatformMemberChange,
  PlatformMemberRepository,
  PlatformMemberStatus,
  PlatformRole,
  PlatformRoleRepository,
  SearchPlatformMembersOptions,
  SearchPlatformRolesOptions,
  UpdatePlatformRoleInput,
} from "@uniora/core";
import {
  MAX_PLATFORM_MEMBER_ROLES,
  PlatformError,
  assertPlatformAuthorization,
  assertPlatformId,
  assertPlatformIdentity,
  assertPlatformVersion,
  assertValidAddPlatformMember,
  assertValidCreatePlatformRole,
  assertValidUpdatePlatformRole,
  sanitizePlatformReason,
} from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { jsonList, parseList } from "../json.js";
import { isForeignKeyViolation, isUniqueViolation as isUniqueConstraint } from "../sqlite-errors.js";

/** A unique violation, or the platform_duplicate abort of the BEFORE INSERT triggers that stop `INSERT OR REPLACE`. */
const isUniqueViolation = (error: unknown): boolean => isUniqueConstraint(error) || (error instanceof Error && error.message.includes("platform_duplicate"));

/** The triggers raise `platform_last_admin: ...` / `platform_role_system: ...`. */
function mapTriggerError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("platform_last_admin")) {
    throw new PlatformError("That would leave the platform without an active Platform Administrator.", "platform_last_admin");
  }
  if (message.includes("platform_role_system")) {
    throw new PlatformError("A system role cannot be changed or deleted.", "platform_role_system");
  }
  throw error;
}

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string;
  is_system: number;
  created_at: string;
  updated_at: string;
  version: number;
}
const ROLE_COLUMNS = "id, key, name, description, permissions, is_system, created_at, updated_at, version";
const toRole = (row: RoleRow): PlatformRole => ({
  id: row.id,
  key: row.key,
  name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  permissions: parseList(row.permissions).sort(),
  isSystem: row.is_system === 1,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  version: row.version,
});

export function createPlatformRoleRepository(db: SqliteExecutor): PlatformRoleRepository {
  return {
    async create(input: CreatePlatformRoleInput) {
      const valid = assertValidCreatePlatformRole(input);
      assertPlatformAuthorization(input.authorization, { operation: valid.isSystem ? "bootstrap" : "role.create" });
      const now = new Date();
      try {
        const result = await db.query<RoleRow>(
          `insert into uniora_platform_roles (id, key, name, description, permissions, is_system, created_at, updated_at)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) returning ${ROLE_COLUMNS}`,
          [input.id, valid.key, valid.name, valid.description ?? null, jsonList(valid.permissions), valid.isSystem, now],
        );
        return toRole(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) throw new PlatformError("A platform role with that id or key already exists.", "platform_role_exists");
        throw error;
      }
    },

    async update(id: string, input: UpdatePlatformRoleInput) {
      assertPlatformAuthorization(input.authorization, { operation: "role.update" });
      const valid = assertValidUpdatePlatformRole(input);
      return db.atomic(async () => {
        const current = (await db.query<RoleRow>(`select ${ROLE_COLUMNS} from uniora_platform_roles where id = ?1`, [id])).rows[0];
        if (!current) throw new PlatformError(`Platform role not found: ${id}`, "platform_role_not_found");
        if (current.is_system === 1) throw new PlatformError("A system role cannot be changed.", "platform_role_system");
        assertPlatformVersion(current, input.expectedVersion);
        const result = await db.query<RoleRow>(
          `update uniora_platform_roles set
             name = coalesce(?2, name),
             description = case when ?3 = 1 then ?4 else description end,
             permissions = coalesce(?5, permissions),
             updated_at = ?6, version = version + 1
           where id = ?1 returning ${ROLE_COLUMNS}`,
          [id, valid.name ?? null, valid.description !== undefined, valid.description ?? null, valid.permissions ? jsonList(valid.permissions) : null, new Date()],
        );
        return toRole(result.rows[0]!);
      });
    },

    async delete(id: string, input: { authorization: UpdatePlatformRoleInput["authorization"] }) {
      assertPlatformAuthorization(input.authorization, { operation: "role.delete" });
      try {
        const result = await db.query(`delete from uniora_platform_roles where id = ?1`, [id]);
        if (result.rowCount === 0) throw new PlatformError(`Platform role not found: ${id}`, "platform_role_not_found");
      } catch (error) {
        // A restrict foreign key surfaces as SQLITE_CONSTRAINT_TRIGGER on some builds: go by the message too.
        if (isForeignKeyViolation(error) || (error instanceof Error && error.message.includes("FOREIGN KEY"))) {
          throw new PlatformError("The role is still held by a platform member.", "platform_role_in_use");
        }
        return mapTriggerError(error);
      }
    },

    async findById(id: string) {
      const row = (await db.query<RoleRow>(`select ${ROLE_COLUMNS} from uniora_platform_roles where id = ?1`, [id])).rows[0];
      return row ? toRole(row) : null;
    },

    async findByKey(key: string) {
      const row = (await db.query<RoleRow>(`select ${ROLE_COLUMNS} from uniora_platform_roles where key = ?1`, [key])).rows[0];
      return row ? toRole(row) : null;
    },

    async findByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<RoleRow>(
        `select ${ROLE_COLUMNS} from uniora_platform_roles where id in (select value from json_each(?1)) order by id`,
        [jsonList(ids)],
      );
      return result.rows.map(toRole);
    },

    async search(options: SearchPlatformRolesOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<RoleRow>(
        `select ${ROLE_COLUMNS} from uniora_platform_roles where (?1 is null or id > ?1) order by id limit ?2`,
        [options.after ?? null, limit],
      );
      return result.rows.map(toRole);
    },
  };
}

interface MemberRow {
  id: string;
  identity_provider: string;
  identity_subject: string;
  status: PlatformMemberStatus;
  created_at: string;
  updated_at: string;
  added_by_provider: string;
  added_by_subject: string;
  status_changed_at: string | null;
  status_changed_by_provider: string | null;
  status_changed_by_subject: string | null;
  status_reason: string | null;
  version: number;
  role_ids: string;
}
const MEMBER_SELECT = `m.id, m.identity_provider, m.identity_subject, m.status, m.created_at, m.updated_at, m.added_by_provider, m.added_by_subject,
  m.status_changed_at, m.status_changed_by_provider, m.status_changed_by_subject, m.status_reason, m.version,
  (select json_group_array(role_id) from (select role_id from uniora_platform_member_roles where member_id = m.id order by role_id)) as role_ids`;
const toMember = (row: MemberRow): PlatformMember => ({
  id: row.id,
  identity: { provider: row.identity_provider, subject: row.identity_subject },
  status: row.status,
  roleIds: parseList(row.role_ids),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  addedBy: { provider: row.added_by_provider, subject: row.added_by_subject },
  ...(row.status_changed_at !== null && row.status_changed_by_provider !== null && row.status_changed_by_subject !== null
    ? {
        statusChange: {
          at: new Date(row.status_changed_at),
          by: { provider: row.status_changed_by_provider, subject: row.status_changed_by_subject },
          ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
        },
      }
    : {}),
  version: row.version,
});

export function createPlatformMemberRepository(db: SqliteExecutor): PlatformMemberRepository {
  const load = async (id: string): Promise<PlatformMember | null> => {
    const row = (await db.query<MemberRow>(`select ${MEMBER_SELECT} from uniora_platform_members m where m.id = ?1`, [id])).rows[0];
    return row ? toMember(row) : null;
  };
  const mustLoad = async (id: string): Promise<PlatformMember> => {
    const member = await load(id);
    if (!member) throw new PlatformError(`Platform member not found: ${id}`, "platform_member_not_found");
    return member;
  };
  const touch = (id: string) =>
    db.query(`update uniora_platform_members set updated_at = ?2, version = version + 1 where id = ?1`, [id, new Date()]);

  const filterOf = (options: Omit<SearchPlatformMembersOptions, "limit" | "after">) => ({
    sql: `(?1 is null or m.status = ?1) and (?2 is null or exists (select 1 from uniora_platform_member_roles x where x.member_id = m.id and x.role_id = ?2))`,
    params: [options.status ?? null, options.roleId ?? null],
  });

  return {
    async add(input: AddPlatformMemberInput) {
      const valid = assertValidAddPlatformMember(input);
      assertPlatformAuthorization(input.authorization, { operation: "member.add", actor: input.addedBy });
      return db.atomic(async () => {
        try {
          await db.query(
            `insert into uniora_platform_members (id, identity_provider, identity_subject, created_at, updated_at, added_by_provider, added_by_subject)
             values (?1, ?2, ?3, ?6, ?6, ?4, ?5)`,
            [input.id, input.identity.provider, input.identity.subject, input.addedBy.provider, input.addedBy.subject, new Date()],
          );
          for (const roleId of valid.roleIds) {
            await db.query(`insert into uniora_platform_member_roles (member_id, role_id) values (?1, ?2)`, [input.id, roleId]);
          }
        } catch (error) {
          if (isUniqueViolation(error)) throw new PlatformError("That identity (or id) already is a platform member.", "platform_member_exists");
          if (isForeignKeyViolation(error)) throw new PlatformError("A platform role does not exist.", "platform_role_not_found");
          throw error;
        }
        return (await load(input.id))!;
      });
    },

    async setStatus(id: string, status: PlatformMemberStatus, input: PlatformMemberChange & { reason?: string }) {
      assertPlatformAuthorization(input.authorization, { operation: "member.status", actor: input.by });
      assertPlatformIdentity(input.by, "acting identity");
      if (status !== "active" && status !== "suspended") throw new PlatformError("The status must be active or suspended.", "platform_member_invalid");
      const reason = sanitizePlatformReason(input.reason);
      return db.atomic(async () => {
        const member = await mustLoad(id);
        assertPlatformVersion(member, input.expectedVersion);
        if (member.status === status) return member;
        try {
          await db.query(
            `update uniora_platform_members set status = ?2, status_changed_at = ?6, status_changed_by_provider = ?3,
               status_changed_by_subject = ?4, status_reason = ?5, updated_at = ?6, version = version + 1
             where id = ?1`,
            [id, status, input.by.provider, input.by.subject, reason ?? null, new Date()],
          );
        } catch (error) {
          return mapTriggerError(error);
        }
        return (await load(id))!;
      });
    },

    async assignRole(id: string, roleId: string, input: PlatformMemberChange) {
      assertPlatformAuthorization(input.authorization, { operation: "member.role", actor: input.by });
      assertPlatformId(roleId, "role");
      return db.atomic(async () => {
        const member = await mustLoad(id);
        assertPlatformVersion(member, input.expectedVersion);
        if (member.roleIds.includes(roleId)) return member;
        if (member.roleIds.length >= MAX_PLATFORM_MEMBER_ROLES) {
          throw new PlatformError(`A platform member holds at most ${MAX_PLATFORM_MEMBER_ROLES} roles.`, "platform_member_invalid");
        }
        try {
          await db.query(`insert into uniora_platform_member_roles (member_id, role_id) values (?1, ?2)`, [id, roleId]);
        } catch (error) {
          if (isForeignKeyViolation(error)) throw new PlatformError(`Platform role not found: ${roleId}`, "platform_role_not_found");
          throw error;
        }
        await touch(id);
        return (await load(id))!;
      });
    },

    async unassignRole(id: string, roleId: string, input: PlatformMemberChange) {
      assertPlatformAuthorization(input.authorization, { operation: "member.role", actor: input.by });
      assertPlatformId(roleId, "role");
      return db.atomic(async () => {
        const member = await mustLoad(id);
        assertPlatformVersion(member, input.expectedVersion);
        if (!member.roleIds.includes(roleId)) return member;
        try {
          await db.query(`delete from uniora_platform_member_roles where member_id = ?1 and role_id = ?2`, [id, roleId]);
        } catch (error) {
          return mapTriggerError(error);
        }
        await touch(id);
        return (await load(id))!;
      });
    },

    async remove(id: string, input: { by: Identity; authorization: PlatformMemberChange["authorization"] }) {
      assertPlatformAuthorization(input.authorization, { operation: "member.remove", actor: input.by });
      await db.atomic(async () => {
        await mustLoad(id);
        try {
          await db.query(`delete from uniora_platform_members where id = ?1`, [id]);
        } catch (error) {
          mapTriggerError(error);
        }
      });
    },

    findById: load,

    async findByIdentity(identity: Identity) {
      const row = (
        await db.query<MemberRow>(`select ${MEMBER_SELECT} from uniora_platform_members m where m.identity_provider = ?1 and m.identity_subject = ?2`, [
          identity.provider,
          identity.subject,
        ])
      ).rows[0];
      return row ? toMember(row) : null;
    },

    async search(options: SearchPlatformMembersOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const { sql, params } = filterOf(options);
      const result = await db.query<MemberRow>(
        `select ${MEMBER_SELECT} from uniora_platform_members m where ${sql} and (?3 is null or m.id > ?3) order by m.id limit ?4`,
        [...params, options.after ?? null, limit],
      );
      return result.rows.map(toMember);
    },

    async count(options = {}) {
      const { sql, params } = filterOf(options);
      const result = await db.query<{ n: number }>(`select count(*) as n from uniora_platform_members m where ${sql}`, params);
      return Number(result.rows[0]!.n);
    },
  };
}
