import type { Identity } from "../identity/types.js";
import { createMemoryStorage } from "../storage/memory.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import { assertPlatformAuthorization } from "./authorization.js";
import { PlatformError } from "./errors.js";
import {
  MAX_PLATFORM_MEMBER_ROLES,
  assertPlatformId,
  assertPlatformIdentity,
  assertPlatformVersion,
  assertValidAddPlatformMember,
  assertValidCreatePlatformRole,
  assertValidUpdatePlatformRole,
  sanitizePlatformReason,
} from "./repository.js";
import type {
  PlatformMemberRepository,
  PlatformRoleRepository,
  PlatformStorage,
  PlatformTransaction,
  SearchPlatformMembersOptions,
  SearchPlatformRolesOptions,
} from "./repository.js";
import { PLATFORM_ADMIN_ROLE_KEY } from "./types.js";
import type { PlatformMember, PlatformRole } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);
const page = <T extends { id: string }>(rows: T[], options: { limit?: number; after?: string }): T[] => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return rows
    .filter((row) => options.after === undefined || row.id > options.after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
};

export interface MemoryPlatformStorageOptions {
  /** Where platform audit entries go. Pass `storage.auditLogs` of the `UnioraStorage` you use so both share one trail. */
  auditLogs?: AuditLogRepository;
}

/** In-memory `PlatformStorage` for tests and prototypes. It enforces the same rules as the database backends. */
export function createMemoryPlatformStorage(options: MemoryPlatformStorageOptions = {}): PlatformStorage {
  const auditLogs = options.auditLogs ?? createMemoryStorage().auditLogs;
  const roles = new Map<string, PlatformRole>();
  const members = new Map<string, PlatformMember>();

  const adminRole = (): PlatformRole | undefined => [...roles.values()].find((role) => role.isSystem && role.key === PLATFORM_ADMIN_ROLE_KEY);
  /** Active members holding the system role, optionally pretending `except` no longer does. */
  const activeAdmins = (except?: string): PlatformMember[] => {
    const admin = adminRole();
    if (!admin) return [];
    return [...members.values()].filter((member) => member.id !== except && member.status === "active" && member.roleIds.includes(admin.id));
  };
  const isAdmin = (member: PlatformMember): boolean => {
    const admin = adminRole();
    return admin !== undefined && member.status === "active" && member.roleIds.includes(admin.id);
  };
  const guardLastAdmin = (member: PlatformMember, whatItDoes: string): void => {
    if (isAdmin(member) && activeAdmins(member.id).length === 0) {
      throw new PlatformError(`${whatItDoes} would leave the platform without an active Platform Administrator.`, "platform_last_admin");
    }
  };

  const roleRepository: PlatformRoleRepository = {
    async create(input) {
      const valid = assertValidCreatePlatformRole(input);
      assertPlatformAuthorization(input.authorization, { operation: valid.isSystem ? "bootstrap" : "role.create" });
      if (roles.has(input.id)) throw new PlatformError(`A platform role with id "${input.id}" already exists.`, "platform_role_exists");
      if ([...roles.values()].some((role) => role.key === valid.key)) {
        throw new PlatformError(`A platform role with key "${valid.key}" already exists.`, "platform_role_exists");
      }
      const now = new Date();
      const role: PlatformRole = {
        id: input.id,
        key: valid.key,
        name: valid.name,
        ...(valid.description !== undefined ? { description: valid.description } : {}),
        permissions: valid.permissions,
        isSystem: valid.isSystem,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      roles.set(role.id, role);
      return clone(role);
    },
    async update(id, input) {
      assertPlatformAuthorization(input.authorization, { operation: "role.update" });
      const role = roles.get(id);
      if (!role) throw new PlatformError(`Platform role not found: ${id}`, "platform_role_not_found");
      if (role.isSystem) throw new PlatformError("A system role cannot be changed.", "platform_role_system");
      const valid = assertValidUpdatePlatformRole(input);
      assertPlatformVersion(role, input.expectedVersion);
      if (valid.name !== undefined) role.name = valid.name;
      if (valid.description !== undefined) {
        if (valid.description === null) delete role.description;
        else role.description = valid.description;
      }
      if (valid.permissions !== undefined) role.permissions = valid.permissions;
      (role as { updatedAt: Date }).updatedAt = new Date();
      (role as { version: number }).version += 1;
      return clone(role);
    },
    async delete(id, input) {
      assertPlatformAuthorization(input.authorization, { operation: "role.delete" });
      const role = roles.get(id);
      if (!role) throw new PlatformError(`Platform role not found: ${id}`, "platform_role_not_found");
      if (role.isSystem) throw new PlatformError("A system role cannot be deleted.", "platform_role_system");
      if ([...members.values()].some((member) => member.roleIds.includes(id))) {
        throw new PlatformError("The role is still held by a platform member.", "platform_role_in_use");
      }
      roles.delete(id);
    },
    async findById(id) {
      const role = roles.get(id);
      return role ? clone(role) : null;
    },
    async findByKey(key) {
      const role = [...roles.values()].find((candidate) => candidate.key === key);
      return role ? clone(role) : null;
    },
    async findByIds(ids) {
      return ids.flatMap((id) => (roles.has(id) ? [clone(roles.get(id)!)] : []));
    },
    async search(searchOptions: SearchPlatformRolesOptions = {}) {
      return page([...roles.values()], searchOptions).map(clone);
    },
  };

  const mustExist = (id: string): PlatformMember => {
    const member = members.get(id);
    if (!member) throw new PlatformError(`Platform member not found: ${id}`, "platform_member_not_found");
    return member;
  };
  const touch = (member: PlatformMember): void => {
    (member as { updatedAt: Date }).updatedAt = new Date();
    (member as { version: number }).version += 1;
  };

  const memberRepository: PlatformMemberRepository = {
    async add(input) {
      const valid = assertValidAddPlatformMember(input);
      assertPlatformAuthorization(input.authorization, { operation: "member.add", actor: input.addedBy });
      if (members.has(input.id)) throw new PlatformError(`A platform member with id "${input.id}" already exists.`, "platform_member_exists");
      if ([...members.values()].some((member) => member.identity.provider === input.identity.provider && member.identity.subject === input.identity.subject)) {
        throw new PlatformError("That identity already is a platform member.", "platform_member_exists");
      }
      for (const roleId of valid.roleIds) {
        if (!roles.has(roleId)) throw new PlatformError(`Platform role not found: ${roleId}`, "platform_role_not_found");
      }
      const now = new Date();
      const member: PlatformMember = {
        id: input.id,
        identity: { provider: input.identity.provider, subject: input.identity.subject },
        status: "active",
        roleIds: valid.roleIds,
        createdAt: now,
        updatedAt: now,
        addedBy: { provider: input.addedBy.provider, subject: input.addedBy.subject },
        version: 1,
      };
      members.set(member.id, member);
      return clone(member);
    },
    async setStatus(id, status, input) {
      assertPlatformAuthorization(input.authorization, { operation: "member.status", actor: input.by });
      assertPlatformIdentity(input.by, "acting identity");
      if (status !== "active" && status !== "suspended") throw new PlatformError("The status must be active or suspended.", "platform_member_invalid");
      const reason = sanitizePlatformReason(input.reason);
      const member = mustExist(id);
      assertPlatformVersion(member, input.expectedVersion);
      if (member.status === status) return clone(member);
      if (status === "suspended") guardLastAdmin(member, "Suspending this member");
      member.status = status;
      (member as { statusChange?: unknown }).statusChange = { at: new Date(), by: { ...input.by }, ...(reason !== undefined ? { reason } : {}) };
      touch(member);
      return clone(member);
    },
    async assignRole(id, roleId, input) {
      assertPlatformAuthorization(input.authorization, { operation: "member.role", actor: input.by });
      assertPlatformId(roleId, "role");
      const member = mustExist(id);
      assertPlatformVersion(member, input.expectedVersion);
      if (!roles.has(roleId)) throw new PlatformError(`Platform role not found: ${roleId}`, "platform_role_not_found");
      if (member.roleIds.includes(roleId)) return clone(member);
      if (member.roleIds.length >= MAX_PLATFORM_MEMBER_ROLES) {
        throw new PlatformError(`A platform member holds at most ${MAX_PLATFORM_MEMBER_ROLES} roles.`, "platform_member_invalid");
      }
      member.roleIds = [...member.roleIds, roleId].sort();
      touch(member);
      return clone(member);
    },
    async unassignRole(id, roleId, input) {
      assertPlatformAuthorization(input.authorization, { operation: "member.role", actor: input.by });
      assertPlatformId(roleId, "role");
      const member = mustExist(id);
      assertPlatformVersion(member, input.expectedVersion);
      if (!member.roleIds.includes(roleId)) return clone(member);
      if (roles.get(roleId)?.isSystem && roles.get(roleId)?.key === PLATFORM_ADMIN_ROLE_KEY) guardLastAdmin(member, "Removing this role");
      member.roleIds = member.roleIds.filter((candidate) => candidate !== roleId);
      touch(member);
      return clone(member);
    },
    async remove(id, input) {
      assertPlatformAuthorization(input.authorization, { operation: "member.remove", actor: input.by });
      const member = mustExist(id);
      guardLastAdmin(member, "Removing this member");
      members.delete(id);
    },
    async findById(id) {
      const member = members.get(id);
      return member ? clone(member) : null;
    },
    async findByIdentity(identity: Identity) {
      const member = [...members.values()].find((candidate) => candidate.identity.provider === identity.provider && candidate.identity.subject === identity.subject);
      return member ? clone(member) : null;
    },
    async search(searchOptions: SearchPlatformMembersOptions = {}) {
      const rows = [...members.values()].filter(
        (member) => (searchOptions.status === undefined || member.status === searchOptions.status) && (searchOptions.roleId === undefined || member.roleIds.includes(searchOptions.roleId)),
      );
      return page(rows, searchOptions).map(clone);
    },
    async count(countOptions = {}) {
      return [...members.values()].filter(
        (member) => (countOptions.status === undefined || member.status === countOptions.status) && (countOptions.roleId === undefined || member.roleIds.includes(countOptions.roleId)),
      ).length;
    },
  };

  // The in-memory backend is single-threaded between awaits only; a chain serialises transactions so check-then-write
  // sequences cannot interleave, like the lock of the database backends.
  let queue: Promise<unknown> = Promise.resolve();
  const scope: PlatformTransaction = { platformRoles: roleRepository, platformMembers: memberRepository, auditLogs };

  return {
    platformRoles: roleRepository,
    platformMembers: memberRepository,
    auditLogs,
    transaction<T>(callback: (tx: PlatformTransaction) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const before = { roles: structuredClone([...roles.entries()]), members: structuredClone([...members.entries()]) };
        try {
          return await callback(scope);
        } catch (error) {
          // Like a database rollback: nothing the callback wrote to roles or members survives a failure.
          roles.clear();
          for (const [key, value] of before.roles) roles.set(key, value);
          members.clear();
          for (const [key, value] of before.members) members.set(key, value);
          throw error;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
