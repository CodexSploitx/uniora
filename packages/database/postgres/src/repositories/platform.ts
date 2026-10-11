import type { Pool } from "pg";
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
  PLATFORM_LOCK_KEY,
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
import type { Queryable } from "../queryable.js";
import { isForeignKeyViolation, isUniqueViolation } from "../pg-errors.js";

const S = "uniora_platform";

/**
 * Runs `work` on a single connection inside a transaction. Inside `storage.transaction()` the repositories are already bound
 * to the caller's client and join it; at the top level (a pool) each write opens its own short transaction, so the
 * advisory lock it takes is held for the whole check-then-write and not released after one statement.
 */
function transactional(db: Queryable, pool: Pool | undefined) {
  return async function run<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
    if (!pool) return work(db);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

const lock = (q: Queryable) => q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [PLATFORM_LOCK_KEY]);

/** The triggers raise `platform_last_admin: ...` / `platform_role_system: ...` with SQLSTATE P0001. */
function mapTriggerError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("platform_last_admin")) {
    throw new PlatformError("That would leave the platform without an active Platform Administrator.", "platform_last_admin");
  }
  if (message.startsWith("platform_role_system")) {
    throw new PlatformError("A system role cannot be changed or deleted.", "platform_role_system");
  }
  throw error;
}

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
  version: number;
}
const ROLE_COLUMNS = "id, key, name, description, permissions, is_system, created_at, updated_at, version";
const toRole = (row: RoleRow): PlatformRole => ({
  id: row.id,
  key: row.key,
  name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  permissions: [...row.permissions].sort(),
  isSystem: row.is_system,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

export function createPlatformRoleRepository(db: Queryable, pool?: Pool): PlatformRoleRepository {
  const run = transactional(db, pool);
  const byId = async (q: Queryable, id: string): Promise<PlatformRole | null> => {
    const result = await q.query<RoleRow>(`select ${ROLE_COLUMNS} from ${S}.roles where id = $1`, [id]);
    return result.rows[0] ? toRole(result.rows[0]) : null;
  };

  return {
    async create(input: CreatePlatformRoleInput) {
      const valid = assertValidCreatePlatformRole(input);
      assertPlatformAuthorization(input.authorization, { operation: valid.isSystem ? "bootstrap" : "role.create" });
      try {
        const result = await db.query<RoleRow>(
          `insert into ${S}.roles (id, key, name, description, permissions, is_system)
           values ($1, $2, $3, $4, $5::text[], $6) returning ${ROLE_COLUMNS}`,
          [input.id, valid.key, valid.name, valid.description ?? null, valid.permissions, valid.isSystem],
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
      return run(async (q) => {
        const current = await q.query<RoleRow>(`select ${ROLE_COLUMNS} from ${S}.roles where id = $1 for update`, [id]);
        const role = current.rows[0];
        if (!role) throw new PlatformError(`Platform role not found: ${id}`, "platform_role_not_found");
        if (role.is_system) throw new PlatformError("A system role cannot be changed.", "platform_role_system");
        assertPlatformVersion(role, input.expectedVersion);
        const result = await q.query<RoleRow>(
          `update ${S}.roles set
             name = coalesce($2, name),
             description = case when $3::boolean then $4 else description end,
             permissions = coalesce($5::text[], permissions),
             updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 returning ${ROLE_COLUMNS}`,
          [id, valid.name ?? null, valid.description !== undefined, valid.description ?? null, valid.permissions ?? null],
        );
        return toRole(result.rows[0]!);
      });
    },

    async delete(id: string, input: { authorization: UpdatePlatformRoleInput["authorization"] }) {
      assertPlatformAuthorization(input.authorization, { operation: "role.delete" });
      try {
        const result = await db.query(`delete from ${S}.roles where id = $1`, [id]);
        if ((result.rowCount ?? 0) === 0) throw new PlatformError(`Platform role not found: ${id}`, "platform_role_not_found");
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new PlatformError("The role is still held by a platform member.", "platform_role_in_use");
        return mapTriggerError(error);
      }
    },

    findById: (id) => byId(db, id),

    async findByKey(key: string) {
      const result = await db.query<RoleRow>(`select ${ROLE_COLUMNS} from ${S}.roles where key = $1`, [key]);
      return result.rows[0] ? toRole(result.rows[0]) : null;
    },

    async findByIds(ids: string[]) {
      if (ids.length === 0) return [];
      const result = await db.query<RoleRow>(`select ${ROLE_COLUMNS} from ${S}.roles where id = any($1::text[]) order by id`, [ids]);
      return result.rows.map(toRole);
    },

    async search(options: SearchPlatformRolesOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<RoleRow>(
        `select ${ROLE_COLUMNS} from ${S}.roles where ($1::text is null or id > $1) order by id limit $2`,
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
  created_at: Date;
  updated_at: Date;
  added_by_provider: string;
  added_by_subject: string;
  status_changed_at: Date | null;
  status_changed_by_provider: string | null;
  status_changed_by_subject: string | null;
  status_reason: string | null;
  version: number;
  role_ids: string[];
}
const MEMBER_SELECT = `m.id, m.identity_provider, m.identity_subject, m.status, m.created_at, m.updated_at, m.added_by_provider, m.added_by_subject,
  m.status_changed_at, m.status_changed_by_provider, m.status_changed_by_subject, m.status_reason, m.version,
  coalesce((select array_agg(mr.role_id order by mr.role_id) from ${S}.member_roles mr where mr.member_id = m.id), '{}') as role_ids`;
const toMember = (row: MemberRow): PlatformMember => ({
  id: row.id,
  identity: { provider: row.identity_provider, subject: row.identity_subject },
  status: row.status,
  roleIds: row.role_ids,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  addedBy: { provider: row.added_by_provider, subject: row.added_by_subject },
  ...(row.status_changed_at !== null && row.status_changed_by_provider !== null && row.status_changed_by_subject !== null
    ? {
        statusChange: {
          at: row.status_changed_at,
          by: { provider: row.status_changed_by_provider, subject: row.status_changed_by_subject },
          ...(row.status_reason !== null ? { reason: row.status_reason } : {}),
        },
      }
    : {}),
  version: row.version,
});

export function createPlatformMemberRepository(db: Queryable, pool?: Pool): PlatformMemberRepository {
  const run = transactional(db, pool);

  const load = async (q: Queryable, id: string, forUpdate = false): Promise<PlatformMember | null> => {
    const result = await q.query<MemberRow>(`select ${MEMBER_SELECT} from ${S}.members m where m.id = $1${forUpdate ? " for update of m" : ""}`, [id]);
    return result.rows[0] ? toMember(result.rows[0]) : null;
  };
  const mustLoad = async (q: Queryable, id: string): Promise<PlatformMember> => {
    const member = await load(q, id, true);
    if (!member) throw new PlatformError(`Platform member not found: ${id}`, "platform_member_not_found");
    return member;
  };

  const filterOf = (options: Omit<SearchPlatformMembersOptions, "limit" | "after">) => ({
    sql: `($1::text is null or m.status = $1) and ($2::text is null or exists (select 1 from ${S}.member_roles x where x.member_id = m.id and x.role_id = $2))`,
    params: [options.status ?? null, options.roleId ?? null],
  });

  return {
    async add(input: AddPlatformMemberInput) {
      const valid = assertValidAddPlatformMember(input);
      assertPlatformAuthorization(input.authorization, { operation: "member.add", actor: input.addedBy });
      return run(async (q) => {
        await lock(q);
        try {
          await q.query(
            `insert into ${S}.members (id, identity_provider, identity_subject, added_by_provider, added_by_subject) values ($1, $2, $3, $4, $5)`,
            [input.id, input.identity.provider, input.identity.subject, input.addedBy.provider, input.addedBy.subject],
          );
          for (const roleId of valid.roleIds) {
            await q.query(`insert into ${S}.member_roles (member_id, role_id) values ($1, $2)`, [input.id, roleId]);
          }
        } catch (error) {
          if (isUniqueViolation(error)) throw new PlatformError("That identity (or id) already is a platform member.", "platform_member_exists");
          if (isForeignKeyViolation(error)) throw new PlatformError("A platform role does not exist.", "platform_role_not_found");
          throw error;
        }
        return (await load(q, input.id))!;
      });
    },

    async setStatus(id: string, status: PlatformMemberStatus, input: PlatformMemberChange & { reason?: string }) {
      assertPlatformAuthorization(input.authorization, { operation: "member.status", actor: input.by });
      assertPlatformIdentity(input.by, "acting identity");
      if (status !== "active" && status !== "suspended") throw new PlatformError("The status must be active or suspended.", "platform_member_invalid");
      const reason = sanitizePlatformReason(input.reason);
      return run(async (q) => {
        await lock(q);
        const member = await mustLoad(q, id);
        assertPlatformVersion(member, input.expectedVersion);
        if (member.status === status) return member;
        try {
          await q.query(
            `update ${S}.members set status = $2, status_changed_at = date_trunc('milliseconds', now()),
               status_changed_by_provider = $3, status_changed_by_subject = $4, status_reason = $5,
               updated_at = date_trunc('milliseconds', now()), version = version + 1
             where id = $1`,
            [id, status, input.by.provider, input.by.subject, reason ?? null],
          );
        } catch (error) {
          return mapTriggerError(error);
        }
        return (await load(q, id))!;
      });
    },

    async assignRole(id: string, roleId: string, input: PlatformMemberChange) {
      assertPlatformAuthorization(input.authorization, { operation: "member.role", actor: input.by });
      assertPlatformId(roleId, "role");
      return run(async (q) => {
        await lock(q);
        const member = await mustLoad(q, id);
        assertPlatformVersion(member, input.expectedVersion);
        if (member.roleIds.includes(roleId)) return member;
        if (member.roleIds.length >= MAX_PLATFORM_MEMBER_ROLES) {
          throw new PlatformError(`A platform member holds at most ${MAX_PLATFORM_MEMBER_ROLES} roles.`, "platform_member_invalid");
        }
        try {
          await q.query(`insert into ${S}.member_roles (member_id, role_id) values ($1, $2)`, [id, roleId]);
        } catch (error) {
          if (isForeignKeyViolation(error)) throw new PlatformError(`Platform role not found: ${roleId}`, "platform_role_not_found");
          throw error;
        }
        await q.query(`update ${S}.members set updated_at = date_trunc('milliseconds', now()), version = version + 1 where id = $1`, [id]);
        return (await load(q, id))!;
      });
    },

    async unassignRole(id: string, roleId: string, input: PlatformMemberChange) {
      assertPlatformAuthorization(input.authorization, { operation: "member.role", actor: input.by });
      assertPlatformId(roleId, "role");
      return run(async (q) => {
        await lock(q);
        const member = await mustLoad(q, id);
        assertPlatformVersion(member, input.expectedVersion);
        if (!member.roleIds.includes(roleId)) return member;
        try {
          await q.query(`delete from ${S}.member_roles where member_id = $1 and role_id = $2`, [id, roleId]);
        } catch (error) {
          return mapTriggerError(error);
        }
        await q.query(`update ${S}.members set updated_at = date_trunc('milliseconds', now()), version = version + 1 where id = $1`, [id]);
        return (await load(q, id))!;
      });
    },

    async remove(id: string, input: { by: Identity; authorization: PlatformMemberChange["authorization"] }) {
      assertPlatformAuthorization(input.authorization, { operation: "member.remove", actor: input.by });
      await run(async (q) => {
        await lock(q);
        await mustLoad(q, id);
        try {
          await q.query(`delete from ${S}.members where id = $1`, [id]);
        } catch (error) {
          mapTriggerError(error);
        }
      });
    },

    findById: (id) => load(db, id),

    async findByIdentity(identity: Identity) {
      const result = await db.query<MemberRow>(
        `select ${MEMBER_SELECT} from ${S}.members m where m.identity_provider = $1 and m.identity_subject = $2`,
        [identity.provider, identity.subject],
      );
      return result.rows[0] ? toMember(result.rows[0]) : null;
    },

    async search(options: SearchPlatformMembersOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const { sql, params } = filterOf(options);
      const result = await db.query<MemberRow>(
        `select ${MEMBER_SELECT} from ${S}.members m where ${sql} and ($3::text is null or m.id > $3) order by m.id limit $4`,
        [...params, options.after ?? null, limit],
      );
      return result.rows.map(toMember);
    },

    async count(options = {}) {
      const { sql, params } = filterOf(options);
      const result = await db.query<{ n: string }>(`select count(*) as n from ${S}.members m where ${sql}`, params);
      return Number(result.rows[0]!.n);
    },
  };
}
