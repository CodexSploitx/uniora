import type { Identity } from "../identity/types.js";

/**
 * Stored lifecycle of an invitation. `expired` is written lazily (when a new
 * invitation for the same organization + email replaces a stale pending one);
 * a `pending` invitation whose `expiresAt` has passed is already unusable —
 * always judge usability with `isInvitationUsable`, never with `status` alone.
 */
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export type InvitationDeliveryStatus = "pending" | "sent" | "failed";

/** What is known about the e-mail side of an invitation. Never contains the token or the accept URL. */
export interface InvitationDelivery {
  status: InvitationDeliveryStatus;
  /** Individual send attempts made over the invitation's whole life (retries included). */
  attempts: number;
  /** Distinct sends: the first one plus every `resend`. */
  sends: number;
  lastAttemptAt?: Date;
  sentAt?: Date;
  /** Sanitized and truncated provider error from the last failed attempt. */
  lastError?: string;
}

/**
 * An offer for `email` to join an organization with specific roles. The
 * secret half (the accept token) is NEVER stored — only its SHA-256 hash —
 * so a database leak does not leak usable invitations.
 */
export interface Invitation {
  readonly id: string;
  readonly organizationId: string;
  /** Normalized (trimmed, lower-cased). */
  readonly email: string;
  readonly roleIds: readonly string[];
  /**
   * Teams of the same organization the invitee joins (as plain members) when they accept. An offer, not a grant: accepting
   * re-checks that the inviter may still add people to each team.
   */
  readonly teamIds: readonly string[];
  readonly invitedBy: Identity;
  status: InvitationStatus;
  readonly createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: Identity;
  revokedAt?: Date;
  delivery: InvitationDelivery;
}

export function isInvitationUsable(invitation: Pick<Invitation, "status" | "expiresAt">, now: Date): boolean {
  return invitation.status === "pending" && invitation.expiresAt.getTime() > now.getTime();
}
