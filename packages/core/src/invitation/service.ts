import type { Identity } from "../identity/types.js";
import type { Membership } from "../membership/types.js";
import type { UnioraStorage } from "../storage/types.js";
import { MembershipError } from "../membership/repository.js";
import { InvitationError } from "./repository.js";
import { generateInvitationToken, hashInvitationToken, randomId } from "./token.js";
import { isInvitationUsable, type Invitation } from "./types.js";
import { sendWithRetry, type DeliveryRetryOptions, type InvitationSender } from "./delivery.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_ROLES_PER_INVITATION = 25;
const GENERIC_ACCEPT_MESSAGE = "This invitation is invalid or has expired.";

/** Pragmatic address check: one `@`, a dotted domain, no whitespace, RFC 5321 length limits. */
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Trims and lower-cases, and refuses anything that is not a plausible single address. */
export function normalizeInvitationEmail(email: string): string {
  const normalized = (email ?? "").trim().toLowerCase();
  const [local = ""] = normalized.split("@");
  if (normalized.length === 0 || normalized.length > 254 || local.length > 64 || !EMAIL_PATTERN.test(normalized)) {
    throw new InvitationError("That is not a valid e-mail address.", "bad_request");
  }
  return normalized;
}

export interface InvitationRateLimits {
  /** New invitations to one e-mail address (any organization) per hour. Default 5. */
  perEmailPerHour?: number;
  /** New invitations created by one organization per hour. Default 200. */
  perOrganizationPerHour?: number;
  /** Minimum time between two sends of the SAME invitation (`resend`). Default 60 s. */
  resendCooldownMs?: number;
}

export interface InvitationServiceOptions {
  storage: UnioraStorage;
  /**
   * Builds the link the invitee opens, from the raw token — typically
   * `` (token) => `https://app.example.com/invite/${token}` ``. The token is
   * secret: put it in the path (or fragment), never anywhere it would be logged.
   */
  acceptUrl: (token: string) => string;
  /** Delivers the e-mail. Without one, invitations are still created and the link is returned for you to hand over. */
  sender?: InvitationSender;
  /** Invitation lifetime. Default 7 days, capped at 30. */
  ttlMs?: number;
  rateLimits?: InvitationRateLimits;
  retry?: DeliveryRetryOptions;
  /** Clock, id source and timers are injectable for tests. */
  now?: () => Date;
  generateId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface InviteInput {
  organizationId: string;
  email: string;
  /** At least one regular role of the organization. The Owner role can never be offered by invitation. */
  roleIds: string[];
  /** The member extending the invitation. The host must have authorized this (e.g. a `members.invite` check). */
  invitedBy: Identity;
  /** Language hint passed to the sender (e.g. `"es"`). Not stored. */
  locale?: string;
}

export interface DeliveryOutcome {
  status: "sent" | "failed" | "skipped";
  attempts: number;
  /** Set when `failed`. Sanitized; safe to show an operator. */
  error?: string;
}

export interface InviteResult {
  invitation: Invitation;
  /** The link containing the secret token. Returned exactly once per issue/resend; it can't be recovered later. */
  acceptUrl: string;
  delivery: DeliveryOutcome;
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  roleNames: string[];
  expiresAt: Date;
}

export interface AcceptInvitationInput {
  token: string;
  /** The identity that just authenticated in the host application. */
  identity: Identity;
  /**
   * The e-mail address the auth provider has VERIFIED for `identity`. It must
   * match the one invited; this is what stops a leaked link from being used
   * by someone else's account. Pass only a provider-verified address.
   */
  verifiedEmail: string;
}

export interface AcceptInvitationResult {
  invitation: Invitation;
  membership: Membership;
  /** `true` when the identity was already a member and only gained the invited roles. */
  alreadyMember: boolean;
}

export interface InvitationService {
  invite(input: InviteInput): Promise<InviteResult>;
  /** Issues a NEW link (the old one stops working), extends the expiry and sends again. */
  resend(invitationId: string, actor: Identity, options?: { locale?: string }): Promise<InviteResult>;
  revoke(invitationId: string, actor: Identity): Promise<Invitation>;
  /** What an accept page may show before sign-in. `null` for any unusable token — no reason is leaked. */
  preview(token: string): Promise<InvitationPreview | null>;
  accept(input: AcceptInvitationInput): Promise<AcceptInvitationResult>;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number.`);
  return value;
}

/**
 * Invitations end to end: issue, deliver (with retries), resend, revoke,
 * preview and accept — over any `UnioraStorage`.
 *
 * Security model:
 * - The token is 256 random bits, shown once, stored only as a SHA-256 hash.
 * - Accepting needs the token AND a provider-verified e-mail equal to the
 *   invited one, and the claim is a single conditional update: concurrent
 *   accepts can't both win, and the claim rolls back with the membership.
 * - Owner can't be granted by invitation (`assignOwnerRole` stays the one,
 *   separately-authorizable path), and roles are re-validated on accept.
 * - Failures that touch an unauthenticated caller are indistinguishable.
 *
 * **No authorization of its own** — same trust boundary as
 * `MembershipRepository.assignRole`: the host decides who may invite.
 */
export function createInvitationService(options: InvitationServiceOptions): InvitationService {
  const { storage, sender } = options;
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? randomId;
  const ttlMs = Math.min(positive(options.ttlMs, 7 * DAY_MS, "ttlMs"), 30 * DAY_MS);
  if (ttlMs <= 0) throw new RangeError("ttlMs must be greater than zero.");
  const limits = {
    perEmailPerHour: positive(options.rateLimits?.perEmailPerHour, 5, "perEmailPerHour"),
    perOrganizationPerHour: positive(options.rateLimits?.perOrganizationPerHour, 200, "perOrganizationPerHour"),
    resendCooldownMs: positive(options.rateLimits?.resendCooldownMs, 60_000, "resendCooldownMs"),
  };

  async function auditEvent(
    tx: Pick<UnioraStorage, "auditLogs">,
    actor: Identity,
    action: string,
    invitation: Invitation,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    // Never the token, never the URL: audit history is append-only and long-lived.
    await tx.auditLogs.record({
      id: generateId(),
      organizationId: invitation.organizationId,
      actor,
      action,
      target: { type: "invitation", id: invitation.id },
      metadata: { email: invitation.email, ...metadata },
    });
  }

  async function assertInvitableRoles(organizationId: string, roleIds: string[]) {
    const unique = [...new Set(roleIds)];
    if (unique.length === 0) throw new InvitationError("Choose at least one role for the invitation.", "bad_request");
    if (unique.length > MAX_ROLES_PER_INVITATION) {
      throw new InvitationError(`An invitation can carry at most ${MAX_ROLES_PER_INVITATION} roles.`, "bad_request");
    }
    const summaries = await storage.roles.findSummariesByIds(unique);
    const byId = new Map(summaries.map((role) => [role.id, role]));
    for (const id of unique) {
      const role = byId.get(id);
      if (!role || role.organizationId !== organizationId) {
        throw new InvitationError("A chosen role does not exist in this organization.", "bad_request");
      }
      if (role.isOwnerRole) {
        throw new InvitationError(
          "The Owner role can't be granted by invitation. Invite with a regular role, then use assignOwnerRole.",
          "bad_request",
        );
      }
    }
    return unique.map((id) => byId.get(id)!);
  }

  async function deliver(invitation: Invitation, token: string, locale: string | undefined, actor: Identity): Promise<{ invitation: Invitation; acceptUrl: string; delivery: DeliveryOutcome }> {
    const acceptUrl = options.acceptUrl(token);
    if (!sender) {
      return { invitation, acceptUrl, delivery: { status: "skipped", attempts: 0 } };
    }

    const [organization, roles] = await Promise.all([
      storage.organizations.findById(invitation.organizationId),
      storage.roles.findSummariesByIds([...invitation.roleIds]),
    ]);
    if (!organization) throw new InvitationError("The organization no longer exists.", "bad_request");

    const outcome = await sendWithRetry(
      sender,
      {
        invitationId: invitation.id,
        to: invitation.email,
        organization: { id: organization.id, name: organization.name, slug: organization.slug },
        roleNames: roles.map((role) => role.name),
        invitedBy: invitation.invitedBy,
        acceptUrl,
        expiresAt: invitation.expiresAt,
        locale,
      },
      { retry: options.retry, secrets: [token, acceptUrl], sleep: options.sleep, random: options.random },
    );

    await storage.invitations.recordDelivery(invitation.id, {
      status: outcome.status,
      attempts: outcome.attempts,
      error: outcome.error,
      at: now(),
    });
    if (outcome.status === "failed") {
      await auditEvent(storage, actor, "invitation.delivery_failed", invitation, {
        attempts: outcome.attempts,
        error: outcome.error,
      });
    }
    const fresh = (await storage.invitations.findById(invitation.id)) ?? invitation;
    return {
      invitation: fresh,
      acceptUrl,
      delivery: { status: outcome.status, attempts: outcome.attempts, error: outcome.error },
    };
  }

  async function checkRate(organizationId: string, email: string): Promise<void> {
    const since = new Date(now().getTime() - HOUR_MS);
    const [forEmail, forOrg] = await Promise.all([
      storage.invitations.countCreatedSince({ email, since }),
      storage.invitations.countCreatedSince({ organizationId, since }),
    ]);
    if (forEmail >= limits.perEmailPerHour || forOrg >= limits.perOrganizationPerHour) {
      throw new InvitationError("Too many invitations were sent recently. Try again later.", "rate_limited");
    }
  }

  return {
    async invite(input) {
      const email = normalizeInvitationEmail(input.email);
      const roles = await assertInvitableRoles(input.organizationId, input.roleIds);
      if (!(await storage.organizations.findById(input.organizationId))) {
        throw new InvitationError("The organization does not exist.", "bad_request");
      }
      await checkRate(input.organizationId, email);

      const token = generateInvitationToken();
      const tokenHash = await hashInvitationToken(token);
      const at = now();

      const invitation = await storage.transaction(async (tx) => {
        await tx.invitations.expireStale(input.organizationId, email, at);
        const created = await tx.invitations.create({
          id: generateId(),
          organizationId: input.organizationId,
          email,
          roleIds: roles.map((role) => role.id),
          tokenHash,
          invitedBy: input.invitedBy,
          createdAt: at,
          expiresAt: new Date(at.getTime() + ttlMs),
        });
        await auditEvent(tx, input.invitedBy, "invitation.created", created, { roles: roles.map((role) => role.name) });
        return created;
      });

      return deliver(invitation, token, input.locale, input.invitedBy);
    },

    async resend(invitationId, actor, resendOptions) {
      const existing = await storage.invitations.findById(invitationId);
      if (!existing || existing.status !== "pending") {
        throw new InvitationError("Only a pending invitation can be sent again.", "invalid");
      }
      const last = existing.delivery.lastAttemptAt;
      if (last && now().getTime() - last.getTime() < limits.resendCooldownMs) {
        throw new InvitationError("This invitation was sent a moment ago. Wait a minute before resending.", "cooldown");
      }

      const token = generateInvitationToken();
      const at = now();
      const rotated = await storage.invitations.rotateToken(existing.id, {
        tokenHash: await hashInvitationToken(token),
        expiresAt: new Date(at.getTime() + ttlMs),
      });
      if (!rotated) throw new InvitationError("Only a pending invitation can be sent again.", "invalid");
      await auditEvent(storage, actor, "invitation.resent", rotated);
      return deliver(rotated, token, resendOptions?.locale, actor);
    },

    async revoke(invitationId, actor) {
      const revoked = await storage.invitations.revoke(invitationId, now());
      if (!revoked) throw new InvitationError("Only a pending invitation can be revoked.", "invalid");
      await auditEvent(storage, actor, "invitation.revoked", revoked);
      return revoked;
    },

    async preview(token) {
      const invitation = await storage.invitations.findByTokenHash(await hashInvitationToken(token ?? ""));
      if (!invitation || !isInvitationUsable(invitation, now())) return null;
      const [organization, roles] = await Promise.all([
        storage.organizations.findById(invitation.organizationId),
        storage.roles.findSummariesByIds([...invitation.roleIds]),
      ]);
      if (!organization) return null;
      return {
        organizationName: organization.name,
        email: invitation.email,
        roleNames: roles.map((role) => role.name),
        expiresAt: invitation.expiresAt,
      };
    },

    async accept(input) {
      const fail = (reason: ConstructorParameters<typeof InvitationError>[1]) =>
        new InvitationError(GENERIC_ACCEPT_MESSAGE, reason);

      const tokenHash = await hashInvitationToken(input.token ?? "");
      const invitation = await storage.invitations.findByTokenHash(tokenHash);
      if (!invitation) throw fail("invalid");
      const at = now();
      if (invitation.status === "accepted") throw fail("already_accepted");
      if (invitation.status === "revoked") throw fail("revoked");
      if (!isInvitationUsable(invitation, at)) throw fail("expired");

      let verified: string;
      try {
        verified = normalizeInvitationEmail(input.verifiedEmail);
      } catch {
        throw fail("email_mismatch");
      }
      if (verified !== invitation.email) throw fail("email_mismatch");

      // Re-validated here, not trusted from issue time: a role may have been
      // deleted, or (defense in depth) turned into the Owner role, since.
      const roles = await storage.roles.findSummariesByIds([...invitation.roleIds]);
      const usable = roles.filter((role) => role.organizationId === invitation.organizationId && !role.isOwnerRole);
      if (usable.length === 0) throw fail("roles_unavailable");

      try {
        return await storage.transaction(async (tx) => {
          const claimed = await tx.invitations.markAccepted({ tokenHash, identity: input.identity, now: at });
          if (!claimed) throw fail("already_accepted"); // lost a race

          let membership = await tx.memberships.findByIdentity(invitation.organizationId, input.identity);
          const alreadyMember = membership !== null;
          if (membership) {
            for (const role of usable) await tx.memberships.assignRole(membership.id, role.id);
            membership = (await tx.memberships.findById(membership.id)) ?? membership;
          } else {
            membership = await tx.memberships.create({
              id: generateId(),
              organizationId: invitation.organizationId,
              identity: input.identity,
              roleIds: usable.map((role) => role.id),
            });
          }

          await auditEvent(tx, input.identity, "invitation.accepted", claimed, {
            membershipId: membership.id,
            alreadyMember,
          });
          return { invitation: claimed, membership, alreadyMember };
        });
      } catch (error) {
        if (error instanceof MembershipError) throw fail("roles_unavailable");
        throw error;
      }
    },
  };
}
