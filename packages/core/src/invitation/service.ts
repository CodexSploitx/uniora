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
  /** New invitations from ONE organization to one e-mail address per hour. Default 5. */
  perEmailPerHour?: number;
  /**
   * New invitations to one e-mail address from ALL organizations per hour — a ceiling against
   * abuse of the mailer, deliberately much higher than `perEmailPerHour` so that organizations
   * an attacker controls can't exhaust a victim's quota for everybody else (audit F-06). Default 50.
   */
  perEmailGlobalPerHour?: number;
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
  /**
   * Lets `invite()` refuse an address that already belongs to a member (`invitation_already_member`). UNIORA stores no
   * e-mails on memberships, so the host answers "which identities own this (normalized) address?" — typically one
   * lookup in its auth provider; return `[]` when it has none. Without it, `invite()` can't tell, and the overlap
   * only shows on accept (`alreadyMember`).
   */
  findIdentitiesByEmail?: (email: string) => Promise<readonly Identity[]>;
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
  /**
   * Invite an address that already belongs to a member anyway (accepting then adds the invited roles). Only matters
   * when the service has `findIdentitiesByEmail`; by default such an invitation is refused.
   */
  allowExistingMember?: boolean;
  /** Lifetime of THIS invitation's link, instead of the service's `ttlMs` (e.g. 24 hours). Greater than zero, 30 days at most. */
  ttlMs?: number;
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

/** Identifies ONE invitation inside ONE organization — the organization is checked, not trusted (audit F-03). */
export interface InvitationRef {
  organizationId: string;
  invitationId: string;
  /** The member performing the action. The host must have authorized it. */
  actor: Identity;
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
  /**
   * Issues a NEW link (the old one stops working), extends the expiry and sends again. An
   * invitation that doesn't belong to `ref.organizationId` is reported exactly like a missing one.
   */
  resend(ref: InvitationRef, options?: { locale?: string; ttlMs?: number }): Promise<InviteResult>;
  revoke(ref: InvitationRef): Promise<Invitation>;
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

  /** A per-call lifetime (`invite` / `resend`), validated like the service's own; the service default when absent. */
  function lifetimeOf(requested: number | undefined): number {
    if (requested === undefined) return ttlMs;
    if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
      throw new InvitationError("ttlMs must be a number greater than zero.", "bad_request");
    }
    return Math.min(requested, 30 * DAY_MS);
  }
  const limits = {
    perEmailPerHour: positive(options.rateLimits?.perEmailPerHour, 5, "perEmailPerHour"),
    perEmailGlobalPerHour: positive(options.rateLimits?.perEmailGlobalPerHour, 50, "perEmailGlobalPerHour"),
    perOrganizationPerHour: positive(options.rateLimits?.perOrganizationPerHour, 200, "perOrganizationPerHour"),
    resendCooldownMs: positive(options.rateLimits?.resendCooldownMs, 60_000, "resendCooldownMs"),
  };

  /**
   * Audit history is append-only and long-lived, so it keeps a salted fingerprint of the invitee's
   * address (enough to correlate events and to prove "this address was invited") instead of the
   * address itself — personal data that could never be erased later (audit F-10).
   */
  async function emailFingerprint(invitation: Invitation): Promise<string> {
    return (await hashInvitationToken(`${invitation.organizationId}:${invitation.email}`)).slice(0, 32);
  }

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
      metadata: { emailFingerprint: await emailFingerprint(invitation), ...metadata },
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

  // The rate check and the insert must not interleave with another `invite()` of this service, or N
  // concurrent calls all see "under the limit" and all succeed (audit F-06). This serializes them
  // in-process; across several processes the check still runs inside the same database transaction
  // as the insert, but only a serializable isolation level (or a database-side counter) closes the
  // window completely — see guides/hardening.md.
  let inviteQueue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = inviteQueue.then(work, work);
    inviteQueue = run.catch(() => undefined);
    return run;
  }

  async function checkRate(repo: Pick<UnioraStorage["invitations"], "countCreatedSince">, organizationId: string, email: string): Promise<void> {
    const since = new Date(now().getTime() - HOUR_MS);
    // Sequential on purpose: inside a transaction all three share one database connection.
    const forEmailInOrg = await repo.countCreatedSince({ organizationId, email, since });
    const forEmailEverywhere = await repo.countCreatedSince({ email, since });
    const forOrg = await repo.countCreatedSince({ organizationId, since });
    if (
      forEmailInOrg >= limits.perEmailPerHour ||
      forEmailEverywhere >= limits.perEmailGlobalPerHour ||
      forOrg >= limits.perOrganizationPerHour
    ) {
      throw new InvitationError("Too many invitations were sent recently. Try again later.", "rate_limited");
    }
  }

  /** Looks the invitation up AND checks it belongs to `ref.organizationId` (audit F-03); a stranger's id is just "not found". */
  async function findInOrganization(ref: InvitationRef): Promise<Invitation | null> {
    if (typeof ref?.organizationId !== "string" || typeof ref?.invitationId !== "string") return null;
    const found = await storage.invitations.findById(ref.invitationId);
    return found && found.organizationId === ref.organizationId ? found : null;
  }

  return {
    async invite(input) {
      const email = normalizeInvitationEmail(input.email);
      const lifetime = lifetimeOf(input.ttlMs);
      const roles = await assertInvitableRoles(input.organizationId, input.roleIds);
      if (!(await storage.organizations.findById(input.organizationId))) {
        throw new InvitationError("The organization does not exist.", "bad_request");
      }

      if (options.findIdentitiesByEmail && !input.allowExistingMember) {
        for (const candidate of await options.findIdentitiesByEmail(email)) {
          if (await storage.memberships.findByIdentity(input.organizationId, candidate)) {
            throw new InvitationError("This e-mail address already belongs to a member of the organization.", "already_member");
          }
        }
      }

      const token = generateInvitationToken();
      const tokenHash = await hashInvitationToken(token);

      const invitation = await serialized(() =>
        storage.transaction(async (tx) => {
          // Cross-process: sorted advisory locks so concurrent invites to the same email/org can't both pass the check.
          for (const key of [`invite:email:${email}`, `invite:org:${input.organizationId}`].sort()) await tx.lock?.(key);
          await checkRate(tx.invitations, input.organizationId, email);
          const at = now();
          await tx.invitations.expireStale(input.organizationId, email, at);
          const created = await tx.invitations.create({
            id: generateId(),
            organizationId: input.organizationId,
            email,
            roleIds: roles.map((role) => role.id),
            tokenHash,
            invitedBy: input.invitedBy,
            createdAt: at,
            expiresAt: new Date(at.getTime() + lifetime),
          });
          await auditEvent(tx, input.invitedBy, "invitation.created", created, { roles: roles.map((role) => role.name) });
          return created;
        }),
      );

      return deliver(invitation, token, input.locale, input.invitedBy);
    },

    async resend(ref, resendOptions) {
      const existing = await findInOrganization(ref);
      if (!existing || existing.status !== "pending") {
        throw new InvitationError("Only a pending invitation can be sent again.", "invalid");
      }
      const last = existing.delivery.lastAttemptAt;
      if (last && now().getTime() - last.getTime() < limits.resendCooldownMs) {
        throw new InvitationError("This invitation was sent a moment ago. Wait a minute before resending.", "cooldown");
      }

      const lifetime = lifetimeOf(resendOptions?.ttlMs);
      const token = generateInvitationToken();
      const at = now();
      const tokenHash = await hashInvitationToken(token);
      const rotated = await storage.transaction(async (tx) => {
        const next = await tx.invitations.rotateToken(existing.id, {
          tokenHash,
          expiresAt: new Date(at.getTime() + lifetime),
        });
        if (next) await auditEvent(tx, ref.actor, "invitation.resent", next);
        return next;
      });
      if (!rotated) throw new InvitationError("Only a pending invitation can be sent again.", "invalid");
      return deliver(rotated, token, resendOptions?.locale, ref.actor);
    },

    async revoke(ref) {
      const existing = await findInOrganization(ref);
      if (!existing) throw new InvitationError("Only a pending invitation can be revoked.", "invalid");
      const revoked = await storage.transaction(async (tx) => {
        const result = await tx.invitations.revoke(existing.id, now());
        if (result) await auditEvent(tx, ref.actor, "invitation.revoked", result);
        return result;
      });
      if (!revoked) throw new InvitationError("Only a pending invitation can be revoked.", "invalid");
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
              invitedBy: invitation.invitedBy,
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
