import { UnioraError } from "../shared/errors.js";
import type { Identity } from "../identity/types.js";
import type { Invitation, InvitationDeliveryStatus, InvitationStatus } from "./types.js";

export type InvitationFailureReason =
  | "invalid" // unknown token, or one that was rotated by a resend
  | "expired"
  | "revoked"
  | "already_accepted"
  | "email_mismatch"
  | "roles_unavailable"
  | "duplicate_pending"
  | "already_member" // `invite()` found the e-mail already belongs to a member of the organization
  | "rate_limited"
  | "cooldown"
  | "bad_request";

/**
 * Failure of an invitation operation. `message` is safe to show to the person
 * holding the link (it never says WHY an accept failed, so it can't be used to
 * probe which invitations or e-mails exist); `reason` is for your own logs and
 * for operator-facing screens — don't forward it to the invitee.
 */
export class InvitationError extends UnioraError {
  constructor(
    message: string,
    readonly reason: InvitationFailureReason = "bad_request",
  ) {
    super(message, `invitation_${reason}`);
    this.name = "InvitationError";
  }
}

export interface CreateInvitationInput {
  id: string;
  organizationId: string;
  /** Already normalized — see `normalizeInvitationEmail`. */
  email: string;
  /** Non-empty, regular (non-Owner) roles of `organizationId`. Validated by the service, re-validated on accept. */
  roleIds: string[];
  /** SHA-256 hex of the accept token. The token itself must never reach a repository. */
  tokenHash: string;
  invitedBy: Identity;
  /** The service's clock, so `createdAt` and `expiresAt` always agree (and rate limits are testable). */
  createdAt: Date;
  expiresAt: Date;
}

export interface SearchInvitationsOptions {
  status?: InvitationStatus;
  /** Case-insensitive substring of the invited e-mail (wildcards in it are matched literally). Blank is ignored. */
  query?: string;
  limit?: number;
  /** Keyset cursor — the `id` of the last invitation of the previous page. Never `offset`. */
  after?: string;
}

export interface RecordDeliveryInput {
  status: Exclude<InvitationDeliveryStatus, "pending">;
  /** Attempts made by THIS send (added to the running total). */
  attempts: number;
  /** Sanitized, already truncated. Only meaningful for `failed`. */
  error?: string;
  at: Date;
}

export interface InvitationRepository {
  /**
   * Inserts a pending invitation. Rejects (`InvitationError`, reason
   * `duplicate_pending`) when the organization already has a pending
   * invitation for the same e-mail — enforced by a real unique index, not
   * only by the check the service makes first.
   */
  create(input: CreateInvitationInput): Promise<Invitation>;
  findById(id: string): Promise<Invitation | null>;
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  /** Newest first, keyset-paged on `id`. */
  search(organizationId: string, options?: SearchInvitationsOptions): Promise<Invitation[]>;
  /** How many invitations of the organization match — same `status` / `query` filters as `search` (`after` and `limit` don't apply). */
  count(organizationId: string, options?: Pick<SearchInvitationsOptions, "status" | "query">): Promise<number>;
  /**
   * Marks as `expired` the organization's pending invitations for `email`
   * whose `expiresAt <= now`, so a fresh invitation can take their place.
   */
  expireStale(organizationId: string, email: string, now: Date): Promise<number>;
  /**
   * Replaces the token hash (the previous link stops working at once) and the
   * expiry of a still-pending invitation, and resets its delivery to
   * `pending`. `null` when it isn't pending.
   */
  rotateToken(id: string, input: { tokenHash: string; expiresAt: Date }): Promise<Invitation | null>;
  /** `pending` → `revoked`. `null` when it isn't pending (already accepted, revoked, expired, or unknown). */
  revoke(id: string, now: Date): Promise<Invitation | null>;
  /**
   * Atomically claims an invitation: `pending` and not expired → `accepted`,
   * recording who accepted it. Exactly one concurrent caller wins; everyone
   * else gets `null`. Does NOT create the membership — the service does that
   * in the same transaction, so a failure rolls the claim back.
   */
  markAccepted(input: { tokenHash: string; identity: Identity; now: Date }): Promise<Invitation | null>;
  recordDelivery(id: string, input: RecordDeliveryInput): Promise<void>;
  /** Invitations created at/after `since`, for one e-mail and/or one organization (rate limiting). */
  countCreatedSince(filter: { organizationId?: string; email?: string; since: Date }): Promise<number>;
}
