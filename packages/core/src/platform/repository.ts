import type { Identity } from "../identity/types.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import { PlatformError } from "./errors.js";
import type { PlatformAuthorization } from "./authorization.js";
import {
  MAX_PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ALL,
  assertValidPlatformPermission,
} from "./permissions.js";
import type { PlatformMember, PlatformMemberStatus, PlatformRole } from "./types.js";

export { PlatformError } from "./errors.js";
export type { PlatformErrorCode } from "./errors.js";

export const MAX_PLATFORM_MEMBER_ROLES = 10;
export const MAX_PLATFORM_ROLE_NAME_LENGTH = 100;
export const MAX_PLATFORM_ROLE_DESCRIPTION_LENGTH = 500;
export const MAX_PLATFORM_REASON_LENGTH = 500;

export interface CreatePlatformRoleInput {
  id: string;
  /** Lowercase handle, 2 to 63 characters (`support`, `billing_ops`). Unique across the platform. */
  key: string;
  name: string;
  description?: string;
  /** `platform.*` keys, at most 100. `platform.*` itself is reserved for the system role. */
  permissions: string[];
  /** Only the bootstrap can create a system role. */
  isSystem?: boolean;
  authorization: PlatformAuthorization;
}

export interface UpdatePlatformRoleInput {
  name?: string;
  /** `null` clears it. */
  description?: string | null;
  permissions?: string[];
  expectedVersion?: number;
  authorization: PlatformAuthorization;
}

export interface SearchPlatformRolesOptions {
  limit?: number;
  /** Keyset cursor: the `id` of the last role of the previous page; results are ordered by `id`. */
  after?: string;
}

export interface PlatformRoleRepository {
  create(input: CreatePlatformRoleInput): Promise<PlatformRole>;
  /** A system role cannot be changed (`platform_role_system`). */
  update(id: string, input: UpdatePlatformRoleInput): Promise<PlatformRole>;
  /** A system role cannot be deleted, nor one that a member still holds (`platform_role_in_use`). */
  delete(id: string, input: { authorization: PlatformAuthorization }): Promise<void>;
  findById(id: string): Promise<PlatformRole | null>;
  findByKey(key: string): Promise<PlatformRole | null>;
  /** Unknown ids are simply absent. */
  findByIds(ids: string[]): Promise<PlatformRole[]>;
  search(options?: SearchPlatformRolesOptions): Promise<PlatformRole[]>;
}

export interface AddPlatformMemberInput {
  id: string;
  identity: Identity;
  /** Existing platform roles, at most 10. */
  roleIds: string[];
  addedBy: Identity;
  authorization: PlatformAuthorization;
}

export interface PlatformMemberChange {
  by: Identity;
  expectedVersion?: number;
  authorization: PlatformAuthorization;
}

export interface SearchPlatformMembersOptions {
  status?: PlatformMemberStatus;
  roleId?: string;
  limit?: number;
  /** Keyset cursor: the `id` of the last member of the previous page; results are ordered by `id`. */
  after?: string;
}

export interface PlatformMemberRepository {
  /** `platform_member_exists` when the identity already is a member; `platform_role_not_found` for an unknown role. */
  add(input: AddPlatformMemberInput): Promise<PlatformMember>;
  /** Refused with `platform_last_admin` when it would leave no active holder of the system role. */
  setStatus(id: string, status: PlatformMemberStatus, input: PlatformMemberChange & { reason?: string }): Promise<PlatformMember>;
  assignRole(id: string, roleId: string, input: PlatformMemberChange): Promise<PlatformMember>;
  /** Refused with `platform_last_admin` when it would leave no active holder of the system role. */
  unassignRole(id: string, roleId: string, input: PlatformMemberChange): Promise<PlatformMember>;
  /** Same `platform_last_admin` guard. */
  remove(id: string, input: { by: Identity; authorization: PlatformAuthorization }): Promise<void>;
  findById(id: string): Promise<PlatformMember | null>;
  /** Exact identity only; no identity link is followed. */
  findByIdentity(identity: Identity): Promise<PlatformMember | null>;
  search(options?: SearchPlatformMembersOptions): Promise<PlatformMember[]>;
  count(options?: Omit<SearchPlatformMembersOptions, "limit" | "after">): Promise<number>;
}

/**
 * The storage of the platform scope. It is a SEPARATE object from `UnioraStorage` on purpose: code that serves an
 * organization never holds it, the databases keep its tables apart (own schema in Postgres) and you can give it its own
 * credentials. In a transaction it also exposes the audit log, so a platform change and its audit entry commit together.
 */
export interface PlatformTransaction {
  platformRoles: PlatformRoleRepository;
  platformMembers: PlatformMemberRepository;
  auditLogs: AuditLogRepository;
  lock?(key: string): Promise<void>;
}

export interface PlatformStorage {
  readonly platformRoles: PlatformRoleRepository;
  readonly platformMembers: PlatformMemberRepository;
  readonly auditLogs: AuditLogRepository;
  transaction<T>(callback: (tx: PlatformTransaction) => Promise<T>): Promise<T>;
}

const ROLE_KEY = /^[a-z][a-z0-9_-]{1,62}$/;

export function assertPlatformIdentity(identity: unknown, what = "identity"): asserts identity is Identity {
  const value = identity as Partial<Identity> | null;
  if (
    !value ||
    typeof value.provider !== "string" ||
    typeof value.subject !== "string" ||
    value.provider.trim() === "" ||
    value.subject.trim() === "" ||
    value.provider.length > 200 ||
    value.subject.length > 500
  ) {
    throw new PlatformError(`The ${what} must have a provider and a subject.`, "platform_member_invalid");
  }
}

export function assertPlatformId(id: unknown, what: string): asserts id is string {
  if (typeof id !== "string" || id.trim() === "" || id.length > 200) {
    throw new PlatformError(`The ${what} id must be a non-empty text of at most 200 characters.`, "platform_invalid");
  }
}

export function sanitizePlatformReason(reason: unknown): string | undefined {
  if (reason === undefined) return undefined;
  const text = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (text === "" || text.length > MAX_PLATFORM_REASON_LENGTH) {
    throw new PlatformError(`A reason must be a non-empty text of at most ${MAX_PLATFORM_REASON_LENGTH} characters.`, "platform_invalid");
  }
  return text;
}

function sanitizeName(name: unknown): string {
  const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (text === "" || text.length > MAX_PLATFORM_ROLE_NAME_LENGTH) {
    throw new PlatformError(`A role name is required, at most ${MAX_PLATFORM_ROLE_NAME_LENGTH} characters.`, "platform_role_invalid");
  }
  return text;
}

function sanitizeDescription(description: unknown): string | undefined {
  if (description === undefined || description === null) return undefined;
  const text = typeof description === "string" ? description.trim().replace(/\s+/g, " ") : "";
  if (text.length > MAX_PLATFORM_ROLE_DESCRIPTION_LENGTH) {
    throw new PlatformError(`A role description has at most ${MAX_PLATFORM_ROLE_DESCRIPTION_LENGTH} characters.`, "platform_role_invalid");
  }
  return text === "" ? undefined : text;
}

/** Sorted, unique, validated. `platform.*` only for a system role. */
export function normalizePlatformPermissions(permissions: unknown, options: { isSystem: boolean }): string[] {
  if (!Array.isArray(permissions)) throw new PlatformError("The permissions must be a list.", "platform_permission_invalid");
  const unique = [...new Set(permissions as unknown[])];
  if (unique.length > MAX_PLATFORM_ROLE_PERMISSIONS) {
    throw new PlatformError(`A platform role carries at most ${MAX_PLATFORM_ROLE_PERMISSIONS} permissions.`, "platform_permission_invalid");
  }
  for (const key of unique) {
    assertValidPlatformPermission(key);
    if (key === PLATFORM_ALL && !options.isSystem) {
      throw new PlatformError('"platform.*" is reserved for the system role; list the prefixes you need (for example "platform.organizations.*").', "platform_permission_invalid");
    }
  }
  return (unique as string[]).sort();
}

export function assertValidCreatePlatformRole(input: CreatePlatformRoleInput): {
  key: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
} {
  assertPlatformId(input.id, "role");
  if (typeof input.key !== "string" || !ROLE_KEY.test(input.key)) {
    throw new PlatformError("A role key is 2 to 63 lowercase letters, digits, hyphens or underscores, starting with a letter.", "platform_role_invalid");
  }
  const isSystem = input.isSystem === true;
  const description = sanitizeDescription(input.description);
  return {
    key: input.key,
    name: sanitizeName(input.name),
    ...(description !== undefined ? { description } : {}),
    permissions: normalizePlatformPermissions(input.permissions, { isSystem }),
    isSystem,
  };
}

export function assertValidUpdatePlatformRole(input: UpdatePlatformRoleInput): {
  name?: string;
  description?: string | null;
  permissions?: string[];
} {
  if (input.name === undefined && input.description === undefined && input.permissions === undefined) {
    throw new PlatformError("Nothing to update: pass a name, a description or permissions.", "platform_role_invalid");
  }
  return {
    ...(input.name !== undefined ? { name: sanitizeName(input.name) } : {}),
    ...(input.description !== undefined ? { description: sanitizeDescription(input.description) ?? null } : {}),
    ...(input.permissions !== undefined ? { permissions: normalizePlatformPermissions(input.permissions, { isSystem: false }) } : {}),
  };
}

export function assertValidAddPlatformMember(input: AddPlatformMemberInput): { roleIds: string[] } {
  assertPlatformId(input.id, "member");
  assertPlatformIdentity(input.identity);
  assertPlatformIdentity(input.addedBy, "adding identity");
  if (!Array.isArray(input.roleIds)) throw new PlatformError("The roles must be a list.", "platform_member_invalid");
  const roleIds = [...new Set(input.roleIds)].sort();
  if (roleIds.length > MAX_PLATFORM_MEMBER_ROLES) {
    throw new PlatformError(`A platform member holds at most ${MAX_PLATFORM_MEMBER_ROLES} roles.`, "platform_member_invalid");
  }
  for (const id of roleIds) assertPlatformId(id, "role");
  return { roleIds };
}

export function assertPlatformVersion(row: { version: number }, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    throw new PlatformError(`The record changed (version ${row.version}, expected ${expectedVersion}).`, "platform_version_conflict");
  }
}

export const PLATFORM_LOCK_KEY = "uniora:platform";
