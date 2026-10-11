import { ApiError, errors } from "../errors.js";
import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { IdentityInput, IdentityOutput, id } from "./common.js";
import { requireInvitations, runAccess, toJson } from "./delegated.js";

const org = id("The organization.", "org_acme");
const invitationId = id("The invitation.", "inv_1");
const orgParams = s.object({ organizationId: org });
const invitationParams = s.object({ organizationId: org, invitationId });

export const InvitationOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  email: s.string({ max: 320, description: "Normalized: trimmed and lower-cased." }),
  roleIds: s.array(s.string({ max: 200 }), { max: 100 }),
  teamIds: s.array(s.string({ max: 200 }), { max: 20 }),
  invitedBy: IdentityOutput,
  status: s.enum(["pending", "accepted", "revoked", "expired"] as const, { description: "A `pending` invitation whose `expiresAt` has passed is already unusable." }),
  createdAt: s.date(),
  expiresAt: s.date(),
  acceptedAt: s.optional(s.date()),
  acceptedBy: s.optional(IdentityOutput),
  revokedAt: s.optional(s.date()),
  delivery: s.object({
    status: s.enum(["pending", "sent", "failed"] as const),
    attempts: s.int({ min: 0, max: 100_000 }),
    sends: s.int({ min: 0, max: 100_000 }),
    lastAttemptAt: s.optional(s.date()),
    sentAt: s.optional(s.date()),
    lastError: s.optional(s.string({ max: 1000, description: "Sanitized. Safe to show an operator." })),
  }),
});

const DeliveryOut = s.object({
  status: s.enum(["sent", "failed", "skipped"] as const),
  attempts: s.int({ min: 0, max: 100_000 }),
  error: s.optional(s.string({ max: 1000 })),
});

const InviteOut = s.object({
  invitation: InvitationOut,
  acceptUrl: s.optional(s.nullable(s.string({ max: 2000, description: "The secret link. Present only when the server is configured to return it (`includeAcceptUrl`), and only once: it cannot be recovered. `null` on a replay." }))),
  delivery: DeliveryOut,
  replayed: s.optional(s.bool({ description: "`true` when the `Idempotency-Key` was already used for this same request: nothing new was made or sent." })),
});

const RULES = ["access_self_change", "access_escalation", "access_target_stronger", "access_owner_protected"] as const;
const COMMON = [
  "actor_required",
  "identity_provider_required",
  "identity_provider_reserved",
  "actor_token_unsupported",
  "forbidden",
  "organization_not_found",
  "invitations_not_configured",
  ...RULES,
] as const;

const DELEGATED_NOTE =
  " A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may invite with those roles (`members.invite` and every permission of every role offered).";

export const invitationRoutes = [
  defineRoute({
    id: "invitations.create",
    method: "POST",
    path: "/v1/organizations/:organizationId/invitations",
    summary: "Invite someone by e-mail",
    description: `Creates the invitation and, if the server has a sender, e-mails the link. The Owner role can never be offered. Send an \`Idempotency-Key\` to make a retry safe: the same key with the same request creates and sends nothing and answers \`replayed: true\`; the same key with a different request is \`invitation_idempotency_conflict\`.${DELEGATED_NOTE}`,
    idempotent: true,
    scope: "invitations:write",
    delegated: true,
    status: 201,
    params: orgParams,
    body: s.object({
      email: s.string({ min: 3, max: 320, example: "ana@example.com" }),
      roleIds: s.array(id("A role of the organization."), { min: 1, max: 20 }),
      teamIds: s.optional(s.array(id("A team the invitee joins on accepting."), { max: 10 })),
      ttlMs: s.optional(s.int({ min: 1, max: 30 * 24 * 3600 * 1000, description: "Lifetime of this link in milliseconds (30 days at most)." })),
      locale: s.optional(s.string({ min: 2, max: 35, description: "Language hint for the e-mail." })),
      allowExistingMember: s.optional(s.bool()),
    }),
    response: InviteOut,
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "invitation_already_member", "invitation_duplicate_pending", "invitation_idempotency_conflict", "invitation_rate_limited", "invitation_teams_forbidden", "invitation_bad_request"],
    async handler(ctx, { params, body }) {
      requireInvitations(ctx);
      return (await runAccess(ctx, "inviteMember", params.organizationId, { ...body, ...(ctx.idempotencyKey !== undefined ? { idempotencyKey: ctx.idempotencyKey } : {}) })) as never;
    },
  }),

  defineRoute({
    id: "invitations.resend",
    method: "POST",
    path: "/v1/organizations/:organizationId/invitations/:invitationId/resend",
    summary: "Send an invitation again",
    description: `Issues a NEW link (the old one stops working), extends the expiry and sends again.${DELEGATED_NOTE}`,
    scope: "invitations:write",
    delegated: true,
    params: invitationParams,
    body: s.object({ locale: s.optional(s.string({ min: 2, max: 35 })), ttlMs: s.optional(s.int({ min: 1, max: 30 * 24 * 3600 * 1000 })) }),
    response: InviteOut,
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "invitation_not_found", "invitation_rate_limited", "invitation_cooldown"],
    async handler(ctx, { params, body }) {
      requireInvitations(ctx);
      return (await runAccess(ctx, "resendInvitation", params.organizationId, { invitationId: params.invitationId, ...body })) as never;
    },
  }),

  defineRoute({
    id: "invitations.revoke",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/invitations/:invitationId",
    summary: "Revoke an invitation",
    description: `The link stops working. An invitation of another organization answers exactly like one that does not exist.${DELEGATED_NOTE}`,
    scope: "invitations:write",
    delegated: true,
    params: invitationParams,
    response: InvitationOut,
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "invitation_not_found"],
    async handler(ctx, { params }) {
      requireInvitations(ctx);
      return (await runAccess(ctx, "revokeInvitation", params.organizationId, { invitationId: params.invitationId })) as never;
    },
  }),

  defineRoute({
    id: "invitations.preview",
    method: "POST",
    path: "/v1/invitations/preview",
    summary: "What an accept page may show before sign-in",
    description:
      "Looks up an invitation by the secret token from its link. Every unusable token (unknown, expired, revoked, already used) answers the same `404 invalid_invitation`, so it cannot be used to probe which links exist. An application call: your server relays the token. It needs a client that may reach every organization, because the token, not the caller, names the organization.",
    scope: "invitations:write",
    allOrganizations: true,
    write: false,
    params: undefined,
    body: s.object({ token: s.string({ min: 16, max: 512, description: "The secret from the accept link." }) }),
    response: s.object({
      organizationName: s.string({ max: 255 }),
      email: s.string({ max: 320 }),
      roleNames: s.array(s.string({ max: 255 }), { max: 100 }),
      teamNames: s.array(s.string({ max: 255 }), { max: 20 }),
      expiresAt: s.date(),
    }),
    errors: ["invalid_invitation", "invitations_not_configured"],
    async handler(ctx, { body }) {
      const { invitations } = ctx.application();
      if (!invitations) throw errors.notImplemented("invitations_not_configured");
      const preview = await invitations.preview(body.token);
      if (!preview) throw errors.notFound("invalid_invitation");
      return preview as never;
    },
  }),

  defineRoute({
    id: "invitations.accept",
    method: "POST",
    path: "/v1/invitations/accept",
    summary: "Accept an invitation as the person who just signed in",
    description:
      "Needs the secret token AND an e-mail your auth provider has VERIFIED for `identity`, equal to the one invited: that is what stops a leaked link from being used by someone else's account. Pass only a provider-verified address, never one the user typed. UNIORA cannot verify it, so this is the one place your server vouches for the person. It re-checks, now, what the inviter may still give (`rolesSkipped`, `teamsSkipped`). Every way an accept can fail answers the same `400 invalid_invitation`. It needs a client that may reach every organization, because the token names the organization.",
    scope: "invitations:write",
    allOrganizations: true,
    body: s.object({
      token: s.string({ min: 16, max: 512, description: "The secret from the accept link." }),
      identity: IdentityInput,
      verifiedEmail: s.string({ min: 3, max: 320, description: "The address the auth provider verified for `identity`." }),
    }),
    response: s.object({
      invitation: InvitationOut,
      membershipId: s.string({ max: 200 }),
      roleIds: s.array(s.string({ max: 200 }), { max: 1000 }),
      rolesSkipped: s.array(s.string({ max: 200 }), { max: 100 }),
      alreadyMember: s.bool(),
      teamIds: s.array(s.string({ max: 200 }), { max: 20 }),
      teamsSkipped: s.array(s.string({ max: 200 }), { max: 20 }),
    }),
    errors: ["invalid_invitation", "invitation_rate_limited", "identity_provider_required", "identity_provider_reserved", "invitations_not_configured"],
    async handler(ctx, { body }) {
      const { invitations } = ctx.application();
      if (!invitations) throw errors.notImplemented("invitations_not_configured");
      const identity = ctx.resolveIdentity(body.identity, "identity");
      let accepted;
      try {
        accepted = await invitations.accept({ token: body.token, identity, verifiedEmail: body.verifiedEmail });
      } catch (error) {
        // The invitee is not signed in to anything of ours: every way a link can be unusable looks the same from outside.
        const reason = (error as { reason?: string }).reason;
        if ((error as { name?: string }).name === "InvitationError" && reason !== "rate_limited" && reason !== "cooldown" && reason !== "bad_request") throw new ApiError(400, "invalid_invitation", { cause: error });
        throw error;
      }
      const result = toJson(accepted) as {
        invitation: unknown;
        membership: { id: string; roleIds: string[] };
        rolesSkipped: string[];
        alreadyMember: boolean;
        teams: { teamId: string }[];
        teamsSkipped: string[];
      };
      return {
        invitation: result.invitation,
        membershipId: result.membership.id,
        roleIds: result.membership.roleIds,
        rolesSkipped: result.rolesSkipped,
        alreadyMember: result.alreadyMember,
        teamIds: result.teams.map((team) => team.teamId),
        teamsSkipped: result.teamsSkipped,
      } as never;
    },
  }),
];
