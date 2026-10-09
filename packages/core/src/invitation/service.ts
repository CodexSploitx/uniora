import type { Identity } from "../identity/types.js";
import type { Membership } from "../membership/types.js";
import type { UnioraStorage } from "../storage/types.js";
import { MembershipError } from "../membership/repository.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import type { AuthorizationEngine, AuthorizationEngineOptions } from "../authorization/engine.js";
import { issueTeamAuthorization } from "../team/authorization.js";
import type { TeamMembership } from "../team/types.js";
import { TEAM_PERMISSIONS } from "../team/service.js";
import { AccessError } from "../access/errors.js";
import { accessSet, issueAccessAuthorization } from "../access/authorization.js";
import type { AccessAuthorization } from "../access/authorization.js";
import { isGuardedStorage } from "../access/guard.js";
import { ACCESS_PERMISSIONS, accessLockKey } from "../access/permissions.js";
import type { AccessPermissionKeys } from "../access/permissions.js";
import { NO_HOLDINGS, covers, holdingsOf, isSameMember, needsOfMembership, needsOfRole } from "../access/power.js";
import { recordAccessRefusal } from "../access/refusal.js";
import { InvitationError } from "./repository.js";
import { generateInvitationToken, hashInvitationToken, randomId } from "./token.js";
import { isInvitationUsable, type Invitation } from "./types.js";
import { sendWithRetry, type DeliveryRetryOptions, type InvitationSender } from "./delivery.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_ROLES_PER_INVITATION = 25;
const MAX_TEAMS_PER_INVITATION = 10;
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

/** Settings for the access rules of the invitation service (see `InvitationServiceOptions.access`). */
export interface InvitationAccessOptions {
  /** Replace any of the default permission keys (`members.invite` is the one this service asks about). */
  permissions?: Partial<AccessPermissionKeys>;
  /**
   * Enforce the rules on a storage that is not wrapped by `createGuardedStorage`. The service then follows them, but other code
   * that holds the storage can still write roles and invitations directly. Off by default (`access_storage_not_guarded`).
   */
  allowUnguardedStorage?: boolean;
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
  /** Passed to the engine that checks, for an invitation offering teams, that the inviter may add people to them. */
  engine?: AuthorizationEngineOptions;
  /** The permission the inviter needs to offer a team. Default `teams.members.add` (`TEAM_PERMISSIONS.membersAdd`). */
  teamPermission?: string;
  /**
   * Make the service decide who may invite with which roles, instead of leaving it to the host (see `createAccessAdminService`
   * for the rules): the inviter needs `members.invite` and must hold every permission of every role offered (the Owner holds all);
   * resending and revoking need the same and a reach over the invitation's roles. Accepting re-checks all of it against what the
   * inviter holds NOW and gives only the roles they could still give (`rolesSkipped`), none at all to the inviter themselves or to
   * a member who holds more power than they do. Refusals are `AccessError`s (`invitationErrorToHttp` answers 403).
   *
   * Default: on when `storage` is wrapped by `createGuardedStorage` (the guard refuses the writes otherwise), off otherwise,
   * which keeps the old behaviour "the host authorizes". `false` turns it off on a guarded storage too, which only works with a
   * trusted one (`createTrustedAccessStorage`). `true` or an object turns it on; on an unguarded storage that also needs
   * `allowUnguardedStorage`.
   */
  access?: boolean | InvitationAccessOptions;
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
  /**
   * Teams of the organization the invitee joins, as plain members, when they accept (at most 10). The inviter must hold
   * `teams.members.add` for each (organization-wide, or inside that team) now AND when the invitation is accepted; a team that
   * is archived or deleted by then, or where the person already has a membership, is skipped and reported, never forced.
   * Being invited grants no role in the team: assign those afterwards with the team service.
   */
  teamIds?: string[];
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
  /**
   * Makes a retry safe: the first call with a key creates the invitation (and sends it); a later call with the same
   * key and the same request (e-mail, roles, `ttlMs`) creates nothing, sends nothing and returns that invitation with
   * `replayed: true` and no link (the link can't be recovered; use `resend` for a new one). The same key with a
   * different request fails with `invitation_idempotency_conflict` (409). Keys are scoped to the organization, 1 to
   * 128 characters of letters, digits and `._:-`, and live as long as the invitation does.
   */
  idempotencyKey?: string;
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
  replayed?: false;
}

/** What `invite({ idempotencyKey })` returns when the key was already used for this same request: nothing new was made. */
export interface InviteReplayResult {
  invitation: Invitation;
  /** There is no link: it was shown by the first call and is not stored. `resend` issues a new one. */
  acceptUrl: null;
  /** The delivery state of the invitation as it stands now. */
  delivery: DeliveryOutcome;
  replayed: true;
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  roleNames: string[];
  /** Names of the teams the invitee will join on accepting (teams that no longer exist are not listed). */
  teamNames: string[];
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
  /** Invited roles that were NOT given because the inviter could no longer give them (always empty without `access`). */
  rolesSkipped: string[];
  /** `true` when the identity was already a member and only gained the invited roles. */
  alreadyMember: boolean;
  /** Team memberships created because the invitation offered them. */
  teams: TeamMembership[];
  /** Offered teams that were NOT joined (the inviter lost the right, the team is archived, or the person already has a membership there). */
  teamsSkipped: string[];
}

export interface InvitationService {
  invite(input: InviteInput & { idempotencyKey: string }): Promise<InviteResult | InviteReplayResult>;
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
  const teamPermission = options.teamPermission ?? TEAM_PERMISSIONS.membersAdd;
  const accessOptions = typeof options.access === "object" ? options.access : undefined;
  const accessEnabled = options.access === undefined ? isGuardedStorage(storage) : options.access !== false;
  if (accessEnabled && !isGuardedStorage(storage) && accessOptions?.allowUnguardedStorage !== true) {
    throw new AccessError(
      "The invitation service enforces the access rules only over a storage wrapped by createGuardedStorage(...). Pass access: { allowUnguardedStorage: true } to accept that.",
      "access_storage_not_guarded",
    );
  }
  const accessKeys: AccessPermissionKeys = { ...ACCESS_PERMISSIONS, ...accessOptions?.permissions };
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

  /** Whether `inviter` may add people to the team: an organization-wide grant, or one inside that very team. */
  async function mayAddToTeam(engine: AuthorizationEngine, organizationId: string, inviter: Identity, teamId: string): Promise<boolean> {
    if (await engine.can({ identity: inviter, organizationId, permission: teamPermission })) return true;
    return engine.can({ identity: inviter, organizationId, permission: teamPermission, teamId });
  }

  async function assertOfferableTeams(organizationId: string, inviter: Identity, teamIds: string[] | undefined): Promise<string[]> {
    const unique = [...new Set(teamIds ?? [])];
    if (unique.length === 0) return [];
    if (unique.length > MAX_TEAMS_PER_INVITATION) {
      throw new InvitationError(`An invitation can offer at most ${MAX_TEAMS_PER_INVITATION} teams.`, "bad_request");
    }
    const engine = createAuthorizationEngine(storage, options.engine);
    for (const teamId of unique) {
      const team = await storage.teams.findById(organizationId, teamId);
      if (!team || team.status !== "active") {
        throw new InvitationError("A chosen team does not exist in this organization or is archived.", "bad_request");
      }
      if (!(await mayAddToTeam(engine, organizationId, inviter, teamId))) {
        throw new InvitationError("The inviter may not add people to a chosen team.", "teams_forbidden");
      }
    }
    return unique.sort();
  }

  /** The engine the access rules ask, bound to `tx` so the decision and the write see the same data. */
  const engineOver = (tx: Parameters<Parameters<UnioraStorage["transaction"]>[0]>[0]) =>
    createAuthorizationEngine({ ...tx, transaction: storage.transaction.bind(storage) } as UnioraStorage, options.engine);

  /**
   * The access rules for creating, resending or revoking: the inviter needs `members.invite` and must hold everything the
   * invitation's roles hold. Runs inside `tx`; returns nothing, throws `AccessError`.
   */
  async function assertMayInvite(
    tx: Parameters<Parameters<UnioraStorage["transaction"]>[0]>[0],
    organizationId: string,
    inviter: Identity,
    roleIds: readonly string[],
  ): Promise<void> {
    await tx.lock?.(accessLockKey(organizationId));
    if (!(await engineOver(tx).can({ identity: inviter, organizationId, permission: accessKeys.membersInvite }))) {
      throw new AccessError("You are not allowed to manage invitations.", "access_forbidden");
    }
    const roles = (await tx.roles.findByIds([...roleIds])).filter((role) => role.organizationId === organizationId);
    const holder = await holdingsOf(tx, organizationId, inviter);
    for (const role of roles) {
      if (!covers(holder, needsOfRole(role))) {
        throw new AccessError("You cannot offer a role that holds permissions you do not hold yourself.", "access_escalation");
      }
    }
  }

  const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
  function assertIdempotencyKey(key: string): string {
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
      throw new InvitationError("idempotencyKey must be 1 to 128 characters of letters, digits and . _ : -", "bad_request");
    }
    return key;
  }

  function replayResult(invitation: Invitation): InviteReplayResult {
    const { delivery } = invitation;
    return {
      invitation,
      acceptUrl: null,
      replayed: true,
      delivery: {
        status: delivery.status === "pending" ? "skipped" : delivery.status,
        attempts: delivery.attempts,
        ...(delivery.lastError !== undefined ? { error: delivery.lastError } : {}),
      },
    };
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
    invite: (async (input: InviteInput): Promise<InviteResult | InviteReplayResult> => {
      const email = normalizeInvitationEmail(input.email);
      const lifetime = lifetimeOf(input.ttlMs);
      const roles = await assertInvitableRoles(input.organizationId, input.roleIds);
      if (!(await storage.organizations.findById(input.organizationId))) {
        throw new InvitationError("The organization does not exist.", "bad_request");
      }
      const teamIds = await assertOfferableTeams(input.organizationId, input.invitedBy, input.teamIds);

      if (options.findIdentitiesByEmail && !input.allowExistingMember) {
        for (const candidate of await options.findIdentitiesByEmail(email)) {
          if (await storage.memberships.findByIdentity(input.organizationId, candidate)) {
            throw new InvitationError("This e-mail address already belongs to a member of the organization.", "already_member");
          }
        }
      }

      const token = generateInvitationToken();
      const tokenHash = await hashInvitationToken(token);
      const idempotency =
        input.idempotencyKey === undefined
          ? undefined
          : {
              key: assertIdempotencyKey(input.idempotencyKey),
              hash: await hashInvitationToken(
                JSON.stringify(
                  teamIds.length === 0
                    ? [email, [...new Set(roles.map((role) => role.id))].sort(), input.ttlMs ?? null]
                    : [email, [...new Set(roles.map((role) => role.id))].sort(), input.ttlMs ?? null, teamIds],
                ),
              ),
            };

      const outcome = await serialized(() =>
        storage.transaction(async (tx): Promise<{ replay: Invitation } | { created: Invitation }> => {
          // Cross-process: sorted advisory locks so concurrent invites to the same email/org can't both pass the check.
          const lockKeys = [`invite:email:${email}`, `invite:org:${input.organizationId}`];
          if (accessEnabled) lockKeys.push(accessLockKey(input.organizationId));
          for (const key of lockKeys.sort()) await tx.lock?.(key);
          // Before the idempotency lookup too: a replay shows an invitation, which only someone allowed to invite may see.
          if (accessEnabled) await assertMayInvite(tx, input.organizationId, input.invitedBy, roles.map((role) => role.id));
          if (idempotency) {
            const earlier = await tx.invitations.findByIdempotencyKey(input.organizationId, idempotency.key);
            if (earlier) {
              if (earlier.hash !== idempotency.hash) {
                throw new InvitationError("This idempotency key was already used for a different invitation.", "idempotency_conflict");
              }
              return { replay: earlier.invitation };
            }
          }
          const invitationId = generateId();
          let authorization: AccessAuthorization | undefined;
          if (accessEnabled) {
            authorization = issueAccessAuthorization(input.invitedBy, {
              operation: "invitation.create",
              target: invitationId,
              detail: accessSet(roles.map((role) => role.id)),
              organizationId: input.organizationId,
            });
          }
          await checkRate(tx.invitations, input.organizationId, email);
          const at = now();
          await tx.invitations.expireStale(input.organizationId, email, at);
          const created = await tx.invitations.create({
            id: invitationId,
            organizationId: input.organizationId,
            email,
            roleIds: roles.map((role) => role.id),
            ...(teamIds.length > 0 ? { teamIds } : {}),
            tokenHash,
            invitedBy: input.invitedBy,
            createdAt: at,
            expiresAt: new Date(at.getTime() + lifetime),
            ...(idempotency ? { idempotency } : {}),
            ...(authorization ? { authorization } : {}),
          });
          await auditEvent(tx, input.invitedBy, "invitation.created", created, {
            roles: roles.map((role) => role.name),
            ...(teamIds.length > 0 ? { teamIds } : {}),
          });
          return { created };
        }),
      ).catch(async (error: unknown) => {
        await recordAccessRefusal(storage, error, {
          organizationId: input.organizationId,
          actor: input.invitedBy,
          operation: "invite",
          target: { type: "organization", id: input.organizationId },
        });
        throw error;
      });

      if ("replay" in outcome) return replayResult(outcome.replay);
      return deliver(outcome.created, token, input.locale, input.invitedBy);
    }) as InvitationService["invite"],

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
      const rotated = await storage
        .transaction(async (tx) => {
          if (accessEnabled) await assertMayInvite(tx, existing.organizationId, ref.actor, existing.roleIds);
          const next = await tx.invitations.rotateToken(existing.id, {
            tokenHash,
            expiresAt: new Date(at.getTime() + lifetime),
            ...(accessEnabled
              ? { authorization: issueAccessAuthorization(ref.actor, { operation: "invitation.manage", target: existing.id, detail: "rotate" }) }
              : {}),
          });
          if (next) await auditEvent(tx, ref.actor, "invitation.resent", next);
          return next;
        })
        .catch(async (error: unknown) => {
          await recordAccessRefusal(storage, error, {
            organizationId: existing.organizationId,
            actor: ref.actor,
            operation: "resend",
            target: { type: "invitation", id: existing.id },
          });
          throw error;
        });
      if (!rotated) throw new InvitationError("Only a pending invitation can be sent again.", "invalid");
      return deliver(rotated, token, resendOptions?.locale, ref.actor);
    },

    async revoke(ref) {
      const existing = await findInOrganization(ref);
      if (!existing) throw new InvitationError("Only a pending invitation can be revoked.", "invalid");
      const revoked = await storage
        .transaction(async (tx) => {
          if (accessEnabled) await assertMayInvite(tx, existing.organizationId, ref.actor, existing.roleIds);
          const result = await tx.invitations.revoke(
            existing.id,
            now(),
            accessEnabled ? { authorization: issueAccessAuthorization(ref.actor, { operation: "invitation.manage", target: existing.id, detail: "revoke" }) } : undefined,
          );
          if (result) await auditEvent(tx, ref.actor, "invitation.revoked", result);
          return result;
        })
        .catch(async (error: unknown) => {
          await recordAccessRefusal(storage, error, {
            organizationId: existing.organizationId,
            actor: ref.actor,
            operation: "revoke",
            target: { type: "invitation", id: existing.id },
          });
          throw error;
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
      const teamNames: string[] = [];
      for (const teamId of invitation.teamIds) {
        const team = await storage.teams.findById(invitation.organizationId, teamId);
        if (team && team.status === "active") teamNames.push(team.name);
      }
      return {
        organizationName: organization.name,
        email: invitation.email,
        roleNames: roles.map((role) => role.name),
        teamNames,
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
          if (accessEnabled) await tx.lock?.(accessLockKey(invitation.organizationId));
          let membership = await tx.memberships.findByIdentity(invitation.organizationId, input.identity);
          const alreadyMember = membership !== null;

          // The offer was authorized when it was made; ask again, here, what the inviter can give NOW. Roles they could not give
          // (they lost the permission, left, or the role grew past them) are skipped and reported, never forced; so is everything
          // when the invitee is the inviter themselves or already holds more power than the inviter (nobody changes their own
          // roles, nobody touches someone above them).
          let grantable = usable;
          let rolesSkipped: string[] = [];
          if (accessEnabled) {
            const inviter = invitation.invitedBy;
            const mayInvite = await engineOver(tx).can({ identity: inviter, organizationId: invitation.organizationId, permission: accessKeys.membersInvite });
            const holder = mayInvite ? await holdingsOf(tx, invitation.organizationId, inviter) : NO_HOLDINGS;
            let reachable = mayInvite;
            // Nobody gives themselves roles by inviting their own address (a support operator would turn a grant into a membership).
            if (reachable) {
              const [a, b] = await Promise.all([tx.identityLinks.resolve(inviter), tx.identityLinks.resolve(input.identity)]);
              reachable = !(a.provider === b.provider && a.subject === b.subject);
            }
            if (reachable && membership) {
              reachable = !(await isSameMember(tx, inviter, membership)) && covers(holder, await needsOfMembership(tx, membership));
            }
            const full = reachable ? await tx.roles.findByIds(usable.map((role) => role.id)) : [];
            const giveable = new Set(full.filter((role) => role.organizationId === invitation.organizationId && !role.isOwnerRole && covers(holder, needsOfRole(role))).map((role) => role.id));
            grantable = usable.filter((role) => giveable.has(role.id));
            rolesSkipped = usable.filter((role) => !giveable.has(role.id)).map((role) => role.id);
            if (grantable.length === 0) throw fail("roles_unavailable");
          }
          // Decided above, before the invitation is claimed: a refusal never uses the invitation up (not even on a backend without rollback).
          const claimed = await tx.invitations.markAccepted({ tokenHash, identity: input.identity, now: at });
          if (!claimed) throw fail("already_accepted"); // lost a race

          const proof = (binding: Parameters<typeof issueAccessAuthorization>[1]) =>
            accessEnabled ? { authorization: issueAccessAuthorization(invitation.invitedBy, binding) } : undefined;

          if (membership) {
            for (const role of grantable) {
              await tx.memberships.assignRole(membership.id, role.id, proof({ operation: "member.role.assign", target: membership.id, detail: role.id }));
            }
            membership = (await tx.memberships.findById(membership.id)) ?? membership;
          } else {
            const membershipId = generateId();
            const roleIds = grantable.map((role) => role.id);
            membership = await tx.memberships.create({
              id: membershipId,
              organizationId: invitation.organizationId,
              identity: input.identity,
              roleIds,
              invitedBy: invitation.invitedBy,
              ...(proof({ operation: "member.create", target: membershipId, detail: accessSet(roleIds), organizationId: invitation.organizationId }) ?? {}),
            });
          }

          const joined: TeamMembership[] = [];
          const teamsSkipped: string[] = [];
          if (invitation.teamIds.length > 0) {
            // The offer was authorized when it was made, but the inviter may have lost the right since: ask again, here,
            // over the same transaction, and join only what they could still do themselves.
            const engine = createAuthorizationEngine(
              { ...tx, transaction: storage.transaction.bind(storage) } as UnioraStorage,
              options.engine,
            );
            for (const teamId of invitation.teamIds) {
              const team = await tx.teams.findById(invitation.organizationId, teamId);
              const existing = team ? await tx.teamMemberships.find(invitation.organizationId, teamId, membership.id) : null;
              const usableTeam =
                team !== null &&
                team.status === "active" &&
                (existing === null || existing.status === "removed") &&
                (await mayAddToTeam(engine, invitation.organizationId, invitation.invitedBy, teamId));
              if (!usableTeam) {
                teamsSkipped.push(teamId);
                continue;
              }
              const row = await tx.teamMemberships.add({
                authorization: issueTeamAuthorization(invitation.organizationId, invitation.invitedBy, ["member.add"]),
                id: generateId(),
                organizationId: invitation.organizationId,
                teamId,
                membershipId: membership.id,
                invitedBy: invitation.invitedBy,
                now: at,
              });
              joined.push(row);
              await tx.auditLogs.record({
                id: generateId(),
                organizationId: invitation.organizationId,
                actor: input.identity,
                action: "team_member.added",
                target: { type: "team_member", id: row.id },
                metadata: { teamId, membershipId: membership.id, via: "invitation", invitationId: invitation.id },
              });
            }
          }

          await auditEvent(tx, input.identity, "invitation.accepted", claimed, {
            membershipId: membership.id,
            alreadyMember,
            ...(invitation.teamIds.length > 0 ? { teamsJoined: joined.map((row) => row.teamId), teamsSkipped } : {}),
          });
          return { invitation: claimed, membership, rolesSkipped, alreadyMember, teams: joined, teamsSkipped };
        });
      } catch (error) {
        if (error instanceof MembershipError) throw fail("roles_unavailable");
        throw error;
      }
    },
  };
}
