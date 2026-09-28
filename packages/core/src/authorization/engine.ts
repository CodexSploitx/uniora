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
  /** At least one of `permission`/`feature` is expected — see `access.check()`. */
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
 *
 * `access.check()` never falls back to an unconditional grant when
 * `permission` is omitted — whether or not `feature` was given: it still
 * verifies real membership in `organizationId` before answering (see the
 * comment inside `check()` below).
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
    // `!== undefined`, never plain truthiness (SECURITY FIX — see
    // docs/security-pentest-2026-09-24.md Hallazgo 10, Ronda 4): a caller
    // that explicitly passes `permission: ""` or `feature: ""` (e.g. an
    // uninitialized variable, a missing route param, a bug upstream) must
    // never be treated the same as "omitted". `if (input.feature)`/
    // `if (input.permission)` are both falsy for `""`, which silently
    // skipped the real check and fell through to a bare membership check —
    // returning `true` for any real member of the organization regardless
    // of whether the (malformed) permission/feature was actually granted.
    // Both `can()` (permissionKeys.includes("")) and `isEnabled(org, "")`
    // correctly deny an empty key on their own — `""` can never be a
    // registered permission or feature key — so routing it through the
    // real check is both correct and safe.
    if (input.feature !== undefined) {
      const enabled = await storage.features.isEnabled(input.organizationId, input.feature);
      if (!enabled) return false;
    }

    if (input.permission !== undefined) {
      // `can()` already re-derives real membership internally, so nothing
      // further is needed on this branch.
      const allowed = await can({
        identity: input.identity,
        organizationId: input.organizationId,
        permission: input.permission,
      });
      if (!allowed) return false;
    } else {
      // No `permission` was requested. This must NOT fall through to an
      // unconditional `true` (SECURITY FIX — see
      // docs/security-pentest-2026-09-24.md Hallazgo 1 *and* Hallazgo 4:
      // Hallazgo 4 is the sibling bug that survived the Hallazgo 1 fix —
      // "feature-only" fell through exactly like "neither" used to, because
      // the fix above only special-cased `!input.permission && !input.feature`
      // instead of "whenever `can()` didn't already run". `Feature.isEnabled`
      // is purely organization-scoped — it says nothing about which identity
      // is asking — so a `feature`-only (or empty) `access.check()` must
      // independently confirm real membership in `organizationId` before
      // answering `true`. This covers an identity with no membership
      // anywhere (INV-002) and a legitimate member of a *different*
      // organization asking about this one (INV-001).
      const membership = await storage.memberships.findByIdentity(input.organizationId, input.identity);
      if (!membership) return false;
    }

    return true;
  }

  return { can, access: { check } };
}
