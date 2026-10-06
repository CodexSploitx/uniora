import type { Identity } from "../identity/types.js";
import type { UnioraStorage } from "../storage/types.js";
import { assertValidPermissionKey } from "../permission/key.js";

/** A permission key the engine will even consider: a string with the registered `resource.action` shape. */
function isWellFormedPermissionKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertValidPermissionKey(value);
    return true;
  } catch {
    return false;
  }
}

/** One authorization decision, as reported to `AuthorizationEngineOptions.onDecision`. */
export interface AuthorizationDecision {
  kind: "can" | "access.check";
  identity: Identity;
  organizationId: string;
  permission?: string;
  feature?: string;
  allowed: boolean;
  /** `malformed_input` when a permission key was refused before touching storage (empty/odd key). */
  reason: "evaluated" | "malformed_input";
  at: Date;
}

export interface AuthorizationEngineOptions {
  /**
   * When `true`, the Owner passes only permission keys registered in the catalog
   * (`storage.permissions.register`), so a typo or a stale constant is denied for the Owner too instead of
   * being invisible to them. Recommended for new installations; defaults to `false` to keep the documented
   * "the Owner can do everything" contract of existing ones.
   */
  ownerRequiresRegisteredPermission?: boolean;
  /**
   * Called after every decision (allow and deny) so the host can keep a
   * forensic trail — the engine itself never writes audit entries. Errors
   * from the hook are swallowed: a failing logger must never change a decision.
   */
  onDecision?: (decision: AuthorizationDecision) => void | Promise<void>;
}

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
 * Everything is denied while the organization is not `active` (suspended or archived), the Owner included.
 *
 * `access.check()` never falls back to an unconditional grant when
 * `permission` is omitted — whether or not `feature` was given: it still
 * verifies real membership in `organizationId` before answering (see the
 * comment inside `check()` below).
 */
export function createAuthorizationEngine(
  storage: UnioraStorage,
  options: AuthorizationEngineOptions = {},
): AuthorizationEngine {
  async function report(decision: Omit<AuthorizationDecision, "at">): Promise<void> {
    if (!options.onDecision) return;
    try {
      await options.onDecision({ ...decision, at: new Date() });
    } catch {
      /* a failing logger never changes the decision */
    }
  }

  const keyOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

  async function organizationIsActive(organizationId: string): Promise<boolean> {
    return (await storage.organizations.findById(organizationId))?.status === "active";
  }

  async function can(input: CanInput): Promise<boolean> {
    const allowed = await evaluateCan(input);
    await report({
      kind: "can",
      identity: input.identity,
      organizationId: input.organizationId,
      permission: keyOf(input.permission),
      allowed,
      reason: isWellFormedPermissionKey(input.permission) ? "evaluated" : "malformed_input",
    });
    return allowed;
  }

  async function evaluateCan(input: CanInput): Promise<boolean> {
    // SECURITY FIX (audit F-02): the Owner bypass below grants ANY key, so a
    // malformed one (`""`, `undefined`, a non-string) is refused first —
    // otherwise an upstream bug that yields an empty key is invisible to
    // Owners (always allowed) and only shows up for everyone else.
    if (!isWellFormedPermissionKey(input.permission)) return false;
    const membership = await storage.memberships.findByIdentity(input.organizationId, input.identity);
    if (!membership || membership.roleIds.length === 0) return false;
    // A blocked member keeps their roles but is denied everything, Owner included.
    if (membership.status !== "active") return false;

    // A suspended or archived organization denies everyone in it, Owner included (and an unknown one, fail-closed).
    if (!(await organizationIsActive(input.organizationId))) return false;

    const roles = (await storage.roles.findByIds(membership.roleIds)).filter(
      (role) => role.organizationId === input.organizationId,
    );
    if (roles.some((role) => role.permissionKeys.includes(input.permission))) return true;
    if (!roles.some((role) => role.isOwnerRole)) return false;
    // Documented contract: the Owner holds every permission. `ownerRequiresRegisteredPermission` narrows
    // that to REGISTERED keys (audit F-02): an unregistered key is a typo or a stale constant, and
    // "unknown permission" is a deny everywhere else in UNIORA.
    if (options.ownerRequiresRegisteredPermission) return (await storage.permissions.findByKey(input.permission)) !== null;
    return true;
  }

  async function check(input: AccessCheckInput): Promise<boolean> {
    const allowed = await evaluateCheck(input);
    await report({
      kind: "access.check",
      identity: input.identity,
      organizationId: input.organizationId,
      permission: keyOf(input.permission),
      feature: keyOf(input.feature),
      allowed,
      reason:
        input.permission !== undefined && !isWellFormedPermissionKey(input.permission) ? "malformed_input" : "evaluated",
    });
    return allowed;
  }

  async function evaluateCheck(input: AccessCheckInput): Promise<boolean> {
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
      const allowed = await evaluateCan({
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
      if (!membership || membership.status !== "active") return false;
      if (!(await organizationIsActive(input.organizationId))) return false;
    }

    return true;
  }

  return { can, access: { check } };
}
