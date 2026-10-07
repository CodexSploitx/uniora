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
  /** Only on `can`: what allowed it — the member's roles or a temporary support grant. */
  via?: "membership" | "support_grant";
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
 * A platform operator who is not a member can act inside an organization only through an ACTIVE support grant
 * (`supportGrants.create`): exactly the permission keys it lists (and what they imply), until it expires or is revoked.
 * A grant never reaches the SQL functions for RLS: operators work through trusted server code, not through row policies.
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
    const { allowed, via } = await decideCan(input);
    await report({
      kind: "can",
      identity: input.identity,
      organizationId: input.organizationId,
      permission: keyOf(input.permission),
      allowed,
      via,
      reason: isWellFormedPermissionKey(input.permission) ? "evaluated" : "malformed_input",
    });
    return allowed;
  }

  async function evaluateCan(input: CanInput): Promise<boolean> {
    return (await decideCan(input)).allowed;
  }

  /** The identities a support grant may be held under: the one asking and the one it is linked to. */
  async function grantIdentities(identity: Identity): Promise<Identity[]> {
    const resolved = await storage.identityLinks.resolve(identity);
    return resolved.provider === identity.provider && resolved.subject === identity.subject ? [identity] : [identity, resolved];
  }

  async function decideCan(input: CanInput): Promise<{ allowed: boolean; via?: "membership" | "support_grant" }> {
    // SECURITY FIX (audit F-02): the Owner bypass below grants ANY key, so a
    // malformed one (`""`, `undefined`, a non-string) is refused first —
    // otherwise an upstream bug that yields an empty key is invisible to
    // Owners (always allowed) and only shows up for everyone else.
    if (!isWellFormedPermissionKey(input.permission)) return { allowed: false };
    const membership = await storage.memberships.findByIdentity(input.organizationId, input.identity);
    // A blocked member keeps their roles but is denied everything, Owner included — and a support grant can't get around the block.
    if (membership && membership.status !== "active") return { allowed: false };

    // A suspended or archived organization denies everyone in it, Owner included (and an unknown one, fail-closed).
    if (!(await organizationIsActive(input.organizationId))) return { allowed: false };

    if (membership && membership.roleIds.length > 0 && (await membershipAllows(input, membership.roleIds))) {
      return { allowed: true, via: "membership" };
    }
    // Last resort: a temporary support grant (a platform operator who is not a member), narrow and expiring.
    const granted = await storage.supportGrants.activePermissions(input.organizationId, await grantIdentities(input.identity));
    if (granted.length > 0) {
      if (granted.includes(input.permission)) return { allowed: true, via: "support_grant" };
      const implying = await storage.permissions.impliedBy(input.permission);
      if (implying.some((key) => granted.includes(key))) return { allowed: true, via: "support_grant" };
    }
    return { allowed: false };
  }

  async function membershipAllows(input: CanInput, roleIds: string[]): Promise<boolean> {
    const roles = (await storage.roles.findByIds(roleIds)).filter((role) => role.organizationId === input.organizationId);
    if (roles.some((role) => role.permissionKeys.includes(input.permission))) return true;
    if (roles.some((role) => role.isOwnerRole)) {
      // Documented contract: the Owner holds every permission. `ownerRequiresRegisteredPermission` narrows
      // that to REGISTERED keys (audit F-02): an unregistered key is a typo or a stale constant, and
      // "unknown permission" is a deny everywhere else in UNIORA.
      if (!options.ownerRequiresRegisteredPermission || (await storage.permissions.findByKey(input.permission)) !== null) return true;
    }
    // A permission another one implies (`appointments.write` implies `appointments.read`): a role holding any
    // of the permissions that imply this one passes. Only looked up after a direct miss.
    const implying = await storage.permissions.impliedBy(input.permission);
    return implying.length > 0 && roles.some((role) => implying.some((key) => role.permissionKeys.includes(key)));
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
      if (membership && membership.status !== "active") return false;
      if (!(await organizationIsActive(input.organizationId))) return false;
      if (!membership) {
        // Not a member: only someone holding an active support grant counts as "inside" the organization.
        const granted = await storage.supportGrants.activePermissions(input.organizationId, await grantIdentities(input.identity));
        if (granted.length === 0) return false;
      }
    }

    return true;
  }

  return { can, access: { check } };
}
