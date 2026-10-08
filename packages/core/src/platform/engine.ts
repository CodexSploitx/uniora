import type { Identity } from "../identity/types.js";
import { PlatformError } from "./errors.js";
import { isValidPlatformPermission, platformPermissionsCover } from "./permissions.js";
import type { PlatformMemberRepository, PlatformRoleRepository } from "./repository.js";
import type { PlatformMember, PlatformRole } from "./types.js";

export interface PlatformDecision {
  identity: Identity;
  permission: string;
  allowed: boolean;
  /** Why it was denied. Never shown to an end user: for logs and metrics. */
  reason?: "invalid_input" | "not_a_member" | "suspended" | "missing_permission";
}

export interface PlatformEngineOptions {
  /** Called after each decision (allowed or denied). A throwing or slow hook never changes the answer. */
  onDecision?: (decision: PlatformDecision) => void | Promise<void>;
}

/**
 * Answers "can this identity do this on the PLATFORM?". It reads only the platform tables: organization memberships,
 * organization roles, Owners, teams and support grants are invisible to it, and the organization engine never reads
 * these tables either. Fail-closed: malformed input, an unknown or suspended member and any error mean "no".
 */
export interface PlatformEngine {
  can(input: { identity: Identity; permission: string }): Promise<boolean>;
  /** The permission keys the identity holds right now (sorted, wildcards as stored); empty unless it is an active member. */
  permissionsOf(identity: Identity): Promise<string[]>;
  /** Like `can` but throws `platform_forbidden`. */
  assertCan(input: { identity: Identity; permission: string }): Promise<void>;
}

export interface PlatformReader {
  platformRoles: Pick<PlatformRoleRepository, "findByIds">;
  platformMembers: Pick<PlatformMemberRepository, "findByIdentity">;
}

export function permissionsOfRoles(roles: readonly PlatformRole[]): string[] {
  return [...new Set(roles.flatMap((role) => role.permissions))].sort();
}

const validIdentity = (identity: unknown): identity is Identity =>
  typeof identity === "object" &&
  identity !== null &&
  typeof (identity as Identity).provider === "string" &&
  typeof (identity as Identity).subject === "string" &&
  (identity as Identity).provider !== "" &&
  (identity as Identity).subject !== "";

export function createPlatformEngine(reader: PlatformReader, options: PlatformEngineOptions = {}): PlatformEngine {
  async function resolve(identity: Identity): Promise<{ member: PlatformMember | null; permissions: string[] }> {
    const member = await reader.platformMembers.findByIdentity(identity);
    if (!member || member.status !== "active") return { member, permissions: [] };
    const roles = await reader.platformRoles.findByIds(member.roleIds);
    return { member, permissions: permissionsOfRoles(roles) };
  }

  async function notify(decision: PlatformDecision): Promise<void> {
    if (!options.onDecision) return;
    try {
      await options.onDecision(decision);
    } catch {
      // A broken hook must never turn a decision into an error or flip it.
    }
  }

  const engine: PlatformEngine = {
    async can({ identity, permission }) {
      if (!validIdentity(identity) || !isValidPlatformPermission(permission, { allowWildcard: false })) {
        if (validIdentity(identity)) await notify({ identity, permission: String(permission), allowed: false, reason: "invalid_input" });
        return false;
      }
      let decision: PlatformDecision;
      try {
        const { member, permissions } = await resolve(identity);
        if (!member) decision = { identity, permission, allowed: false, reason: "not_a_member" };
        else if (member.status !== "active") decision = { identity, permission, allowed: false, reason: "suspended" };
        else if (platformPermissionsCover(permissions, permission)) decision = { identity, permission, allowed: true };
        else decision = { identity, permission, allowed: false, reason: "missing_permission" };
      } catch {
        return false;
      }
      await notify(decision);
      return decision.allowed;
    },
    async permissionsOf(identity) {
      if (!validIdentity(identity)) return [];
      try {
        return (await resolve(identity)).permissions;
      } catch {
        return [];
      }
    },
    async assertCan(input) {
      if (!(await engine.can(input))) throw new PlatformError("You are not allowed to do this on the platform.", "platform_forbidden");
    },
  };
  return engine;
}
