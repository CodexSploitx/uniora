import type { Identity } from "../identity/types.js";

export type SupportGrantStatus = "active" | "expired" | "revoked";

/**
 * Temporary, narrow, audited access for someone who is NOT a member of an organization: a platform operator
 * (your own staff, a support agent) who needs to look at or fix something in a customer's organization.
 * It carries an explicit list of permission keys and an expiry, never "everything": there is no way to grant the Owner role this way.
 */
export interface SupportGrant {
  readonly id: string;
  readonly organizationId: string;
  /** The person who gets access. */
  readonly operator: Identity;
  /** Who authorised it (the organization's admin who asked for help, or the operator's own manager). */
  readonly grantedBy: Identity;
  /** Why, in the grantor's words (required, at most 500 characters). */
  readonly reason: string;
  /** The only permissions the grant allows (and what they imply); sorted, at most 50. */
  readonly permissions: string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly revokedBy?: Identity;
}
