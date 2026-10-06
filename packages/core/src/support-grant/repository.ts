import { UnioraError } from "../shared/errors.js";
import type { Identity } from "../identity/types.js";
import { assertValidPermissionKey } from "../permission/key.js";
import type { SupportGrant, SupportGrantStatus } from "./types.js";

export type SupportGrantErrorCode =
  | "support_grant_invalid"
  | "support_grant_exists"
  | "support_grant_reason_invalid"
  | "support_grant_permission_invalid"
  | "support_grant_expiry_invalid"
  | "support_grant_organization_unknown";

export class SupportGrantError extends UnioraError {
  constructor(message: string, code: SupportGrantErrorCode = "support_grant_invalid") {
    super(message, code);
    this.name = "SupportGrantError";
  }
}

/** The longest a grant can last from the moment it is created: 30 days. Renew it deliberately instead. */
export const MAX_SUPPORT_GRANT_MS = 30 * 24 * 3600 * 1000;
export const MAX_SUPPORT_GRANT_PERMISSIONS = 50;
export const MAX_SUPPORT_GRANT_REASON_LENGTH = 500;

export interface CreateSupportGrantInput {
  id: string;
  organizationId: string;
  operator: Identity;
  grantedBy: Identity;
  reason: string;
  /** Registered permission keys, 1 to 50. */
  permissions: string[];
  /** Strictly in the future and at most 30 days away. */
  expiresAt: Date;
  /** The clock; for tests. */
  now?: Date;
}

export interface SearchSupportGrantsOptions {
  organizationId?: string;
  operator?: Identity;
  status?: SupportGrantStatus;
  limit?: number;
  /** Keyset cursor: the `id` of the last grant of the previous page; results are ordered by `id`. */
  after?: string;
  now?: Date;
}

export interface SupportGrantRepository {
  /** Rejects an unknown organization or permission, an expiry past 30 days, a missing reason, and a repeated id. */
  create(input: CreateSupportGrantInput): Promise<SupportGrant>;
  /** Ends a grant now. Idempotent: an already revoked grant is returned as it was; `null` when unknown. */
  revoke(id: string, input: { by: Identity; now?: Date }): Promise<SupportGrant | null>;
  findById(id: string): Promise<SupportGrant | null>;
  search(options?: SearchSupportGrantsOptions): Promise<SupportGrant[]>;
  count(options?: Omit<SearchSupportGrantsOptions, "limit" | "after">): Promise<number>;
  /**
   * The union of the permission keys of every ACTIVE grant (not revoked, not expired) that any of `identities` holds in
   * the organization. The authorization engine uses it; pass the identity and the one it resolves to through a link.
   */
  activePermissions(organizationId: string, identities: Identity[], now?: Date): Promise<string[]>;
}

export function grantStatus(grant: Pick<SupportGrant, "expiresAt" | "revokedAt">, now: Date): SupportGrantStatus {
  if (grant.revokedAt) return "revoked";
  return grant.expiresAt.getTime() > now.getTime() ? "active" : "expired";
}

/** Validates a creation input the same way in every backend; returns the sanitised reason and the sorted, unique permissions. */
export function assertValidSupportGrant(input: CreateSupportGrantInput): { reason: string; permissions: string[]; now: Date } {
  const now = input.now ?? new Date();
  if (typeof input.id !== "string" || input.id.trim() === "" || input.id.length > 200) {
    throw new SupportGrantError("The grant id must be a non-empty text of at most 200 characters.");
  }
  for (const identity of [input.operator, input.grantedBy]) {
    if (!identity || typeof identity.provider !== "string" || typeof identity.subject !== "string" || identity.provider === "" || identity.subject === "") {
      throw new SupportGrantError("The operator and the grantor must be identities.");
    }
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ") : "";
  if (reason === "" || reason.length > MAX_SUPPORT_GRANT_REASON_LENGTH) {
    throw new SupportGrantError(`A reason is required, at most ${MAX_SUPPORT_GRANT_REASON_LENGTH} characters.`, "support_grant_reason_invalid");
  }
  if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
    throw new SupportGrantError("A grant needs at least one permission.", "support_grant_permission_invalid");
  }
  const permissions = [...new Set(input.permissions)].sort();
  if (permissions.length > MAX_SUPPORT_GRANT_PERMISSIONS) {
    throw new SupportGrantError(`A grant carries at most ${MAX_SUPPORT_GRANT_PERMISSIONS} permissions.`, "support_grant_permission_invalid");
  }
  for (const key of permissions) {
    try {
      assertValidPermissionKey(key);
    } catch {
      throw new SupportGrantError("A grant can only carry well-formed permission keys.", "support_grant_permission_invalid");
    }
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new SupportGrantError("The expiry must be a date.", "support_grant_expiry_invalid");
  }
  if (input.expiresAt.getTime() <= now.getTime() || input.expiresAt.getTime() - now.getTime() > MAX_SUPPORT_GRANT_MS) {
    throw new SupportGrantError("A grant must expire in the future and within 30 days.", "support_grant_expiry_invalid");
  }
  return { reason, permissions, now };
}
