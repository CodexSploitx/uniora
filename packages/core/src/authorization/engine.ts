import type { Identity } from "../identity/types.js";
import type { UnioraStorage } from "../storage/types.js";

export interface CanInput {
  identity: Identity;
  organizationId: string;
  permission: string;
}

export interface AccessCheckInput {
  identity: Identity;
  organizationId: string;
  permission?: string;
  feature?: string;
}

export interface AuthorizationEngine {
  can(input: CanInput): Promise<boolean>;
  access: {
    check(input: AccessCheckInput): Promise<boolean>;
  };
}

/**
 * Deny-by-default authorization engine (docs/PROYECT.md §6, §33).
 *
 * A permission is only granted when there is a real Membership linking the
 * identity to the organization, and one of that membership's roles —
 * scoped to the SAME organization — carries the permission. Roles from
 * another organization are never trusted, even if their id were guessable.
 *
 * The one exception is the protected Owner role (`role.isOwnerRole`):
 * it grants every permission unconditionally, regardless of
 * `permissionKeys` — see `RoleRepository.createOwnerRole` and
 * uniora-security-engineering §11 (Owner Protection).
 */
export function createAuthorizationEngine(storage: UnioraStorage): AuthorizationEngine {
  async function can(input: CanInput): Promise<boolean> {
    const membership = await storage.memberships.findByIdentity(input.organizationId, input.identity);
    if (!membership || membership.roleIds.length === 0) return false;

    const roles = await storage.roles.findByIds(membership.roleIds);
    return roles.some(
      (role) =>
        role.organizationId === input.organizationId &&
        (role.isOwnerRole || role.permissionKeys.includes(input.permission)),
    );
  }

  async function check(input: AccessCheckInput): Promise<boolean> {
    if (input.feature) {
      const enabled = await storage.features.isEnabled(input.organizationId, input.feature);
      if (!enabled) return false;
    }

    if (input.permission) {
      const allowed = await can({
        identity: input.identity,
        organizationId: input.organizationId,
        permission: input.permission,
      });
      if (!allowed) return false;
    }

    return true;
  }

  return { can, access: { check } };
}
