import { computeAuthorizationSnapshot } from "@uniora/core";
import type { AuthorizationReason } from "@uniora/core";
import { errors } from "../errors.js";
import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { IdentityInput, id, mapPool } from "./common.js";

const permissionKey = (description: string) => s.string({ min: 1, max: 200, description, example: "vehicles.delete" });
const featureKey = (description: string) => s.string({ min: 1, max: 200, description, example: "advanced_reports" });
const teamId = s.optional(s.string({ min: 1, max: 200, description: "Ask inside this team: it can only narrow the answer." }));

const Check = s.object({
  permission: s.optional(permissionKey("The permission the identity needs.")),
  feature: s.optional(featureKey("The feature the organization needs enabled.")),
  teamId,
});

const REASONS = [
  "allowed",
  "malformed_input",
  "cross_tenant_resource",
  "organization_inactive",
  "membership_inactive",
  "permission_denied",
  "policy_denied",
  "policy_indeterminate",
  "no_applicable_policy",
  "evaluation_error",
  "policy_set_too_large",
] as const satisfies readonly AuthorizationReason[];

const needsPermissionOrFeature = (input: { permission?: string | undefined; feature?: string | undefined }, prefix = "") =>
  input.permission === undefined && input.feature === undefined
    ? [{ path: `${prefix}permission`, code: "required" as const }]
    : [];

export const decisionRoutes = [
  defineRoute({
    id: "decisions.check",
    method: "POST",
    path: "/v1/check",
    summary: "May this identity do this?",
    description:
      "Answers with the role-based decision of the engine: whether the identity holds the permission in the organization (and, if asked, whether the organization has the feature enabled). Anything the engine cannot justify is `false`; an unknown organization, a non-member and a malformed key all answer `false` the same way. Policies are not applied here: use `authorize` for that.",
    scope: "check",
    write: false,
    body: s.object({
      identity: IdentityInput,
      organizationId: id("The organization the question is about.", "org_acme"),
      permission: s.optional(permissionKey("The permission the identity needs.")),
      feature: s.optional(featureKey("The feature the organization needs enabled.")),
      teamId,
    }),
    response: s.object({ allowed: s.bool({ description: "`true` only when every part of the question holds." }) }),
    organization: ({ body }) => body.organizationId,
    refine: ({ body }) => needsPermissionOrFeature(body),
    errors: ["identity_provider_required", "identity_provider_reserved", "organization_not_found"],
    async handler(ctx, { body }) {
      const identity = ctx.resolveIdentity(body.identity, "identity");
      const allowed =
        body.feature !== undefined
          ? await ctx.engine.access.check({
              identity,
              organizationId: body.organizationId,
              ...(body.permission !== undefined ? { permission: body.permission } : {}),
              feature: body.feature,
              ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
            })
          : await ctx.engine.can({
              identity,
              organizationId: body.organizationId,
              permission: body.permission!,
              ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
            });
      return { allowed };
    },
  }),

  defineRoute({
    id: "decisions.checkBatch",
    method: "POST",
    path: "/v1/check:batch",
    summary: "Several questions about one identity in one round trip",
    description:
      "Each check is evaluated independently, in the order given, and the answers come back in the same order. Use it to render a whole screen in one call. A malformed check answers `false` for that entry only.",
    scope: "check",
    write: false,
    body: s.object({
      identity: IdentityInput,
      organizationId: id("The organization the questions are about.", "org_acme"),
      checks: s.array(Check, { min: 1, max: 1000, description: "At most the server's batch limit (50 unless configured)." }),
    }),
    response: s.object({ results: s.array(s.object({ allowed: s.bool() }), { max: 1000 }) }),
    organization: ({ body }) => body.organizationId,
    refine: ({ body }) => body.checks.flatMap((check, index) => needsPermissionOrFeature(check, `checks[${index}].`)),
    errors: ["identity_provider_required", "identity_provider_reserved", "organization_not_found"],
    async handler(ctx, { body }) {
      if (body.checks.length > ctx.config.limits.maxBatchChecks) throw errors.invalidRequest([{ path: "checks", code: "too_many" }]);
      const identity = ctx.resolveIdentity(body.identity, "identity");
      const results = await mapPool(body.checks, 8, async (check) => ({
        allowed:
          check.feature !== undefined
            ? await ctx.engine.access.check({
                identity,
                organizationId: body.organizationId,
                ...(check.permission !== undefined ? { permission: check.permission } : {}),
                feature: check.feature,
                ...(check.teamId !== undefined ? { teamId: check.teamId } : {}),
              })
            : await ctx.engine.can({
                identity,
                organizationId: body.organizationId,
                permission: check.permission!,
                ...(check.teamId !== undefined ? { teamId: check.teamId } : {}),
              }),
      }));
      return { results };
    },
  }),

  defineRoute({
    id: "decisions.authorize",
    method: "POST",
    path: "/v1/authorize",
    summary: "The full decision, with the organization's policies",
    description:
      "Like `check`, and then the organization's policies are applied on top of the roles (they can only restrict). Pass what YOUR server knows: the resource, the signals about the request (`context`) and how the person authenticated (`session`). UNIORA cannot verify those, so never copy them from what the end user sent. The answer never throws: a failure while deciding is `allowed: false`. When the refusal comes only from policies that stronger or fresher authentication could satisfy, `stepUp` says so: send the person to your own sign-in flow and ask again.",
    scope: "check",
    write: false,
    body: s.object({
      identity: IdentityInput,
      organizationId: id("The organization the question is about.", "org_acme"),
      permission: permissionKey("The permission the identity needs."),
      teamId,
      resource: s.optional(
        s.object(
          {
            type: s.string({ min: 1, max: 64, description: "What kind of resource (`vehicle`, `ticket`): policies are matched on it.", example: "vehicle" }),
            id: id("The resource's id in your database.", "veh_42"),
            organizationId: id("The organization the resource belongs to, as YOUR database says. A mismatch is `cross_tenant_resource`."),
            teamIds: s.optional(s.array(id("A team the resource belongs to."), { max: 50 })),
            attributes: s.optional(
              s.record(s.json({ maxDepth: 2, maxNodes: 100, maxString: 500 }), {
                maxKeys: 50,
                keyPattern: /^[A-Za-z][A-Za-z0-9_.]{0,63}$/,
                description: "The values of the attributes the policies declare (`status`, `ownerIdentity`...).",
              }),
            ),
          },
          { description: "The thing the question is about." },
        ),
      ),
      context: s.optional(
        s.record(s.json({ maxDepth: 2, maxNodes: 100, maxString: 500 }), {
          maxKeys: 20,
          keyPattern: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
          description: "Signals about the request that your server verified (`{ \"ipCountry\": \"ES\" }`). Only the ones a policy declares are used.",
        }),
      ),
      session: s.optional(
        s.object(
          {
            authenticatedAt: s.optional(s.date({ description: "When the person last proved who they are (a sign-in or a step-up), NOT when the session began." })),
            startedAt: s.optional(s.date({ description: "When the session began." })),
            mfa: s.optional(s.bool({ description: "Whether a second factor was used." })),
            assuranceLevel: s.optional(s.int({ min: 0, max: 100 })),
            methods: s.optional(s.array(s.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_.:-]{1,64}$/ }), { max: 16 })),
          },
          { description: "How the person authenticated, as your server's authentication states it." },
        ),
      ),
      requireApplicablePolicy: s.optional(s.bool({ description: "A protected operation: with no applicable policy the answer is deny." })),
    }),
    response: s.object({
      allowed: s.bool({ description: "Check this, not `decision`." }),
      decision: s.enum(["allow", "deny", "indeterminate"] as const, { description: "Only `allow` lets the operation go on." }),
      reason: s.enum(REASONS, { description: "Why. Stable codes; only ever added." }),
      via: s.optional(s.enum(["membership", "support_grant"] as const, { description: "What granted the permission." })),
      policyRevision: s.nullable(s.int({ min: 0, max: Number.MAX_SAFE_INTEGER, description: "The revision of the organization's policy set that the decision used (`0` when it has no policies yet); `null` when the roles refused first, so no policy was consulted. Key any cache of decisions on it." })),
      stepUp: s.optional(
        s.object({ policyKeys: s.array(s.string({ max: 200 }), { max: 100 }) }, { description: "Present only when stronger or fresher authentication could change the answer. Do not echo the keys to the person." }),
      ),
      evaluatedAt: s.date(),
    }),
    organization: ({ body }) => body.organizationId,
    errors: ["identity_provider_required", "identity_provider_reserved", "organization_not_found"],
    async handler(ctx, { body }) {
      const identity = ctx.resolveIdentity(body.identity, "identity");
      const result = await ctx.engine.authorize({
        identity,
        organizationId: body.organizationId,
        permission: body.permission,
        ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
        ...(body.resource
          ? {
              resource: {
                type: body.resource.type,
                id: body.resource.id,
                organizationId: body.resource.organizationId,
                ...(body.resource.teamIds !== undefined ? { teamIds: body.resource.teamIds } : {}),
                ...(body.resource.attributes !== undefined ? { attributes: body.resource.attributes } : {}),
              },
            }
          : {}),
        ...(body.context !== undefined ? { context: body.context } : {}),
        ...(body.session !== undefined ? { session: body.session } : {}),
        ...(body.requireApplicablePolicy !== undefined ? { requireApplicablePolicy: body.requireApplicablePolicy } : {}),
      });
      return {
        allowed: result.allowed,
        decision: result.decision,
        reason: result.reason,
        ...(result.via !== undefined ? { via: result.via } : {}),
        policyRevision: result.policyRevision,
        ...(result.stepUp !== undefined ? { stepUp: { policyKeys: result.stepUp.policyKeys } } : {}),
        evaluatedAt: result.evaluatedAt,
      };
    },
  }),

  defineRoute({
    id: "decisions.snapshot",
    method: "POST",
    path: "/v1/snapshots",
    summary: "A bounded set of decisions for a UI, in one call",
    description:
      "Resolves exactly the permissions and features listed, for one identity in one organization. It is bounded on purpose: this is not \"everything this person can do\" (which is not even defined for an Owner). A key you did not list is absent, and a consumer must treat an absent key as denied. Safe to hand to client-side UI after your own server authorizes the request.",
    scope: "check",
    write: false,
    body: s.object({
      identity: IdentityInput,
      organizationId: id("The organization the snapshot is about.", "org_acme"),
      permissions: s.optional(s.array(permissionKey("A permission to resolve."), { max: 100 })),
      features: s.optional(s.array(featureKey("A feature to resolve."), { max: 100 })),
    }),
    response: s.object({
      organizationId: s.string({ max: 200 }),
      permissions: s.record(s.bool(), { maxKeys: 100, keyPattern: /^[\x21-\x7e]{1,200}$/ }),
      features: s.record(s.bool(), { maxKeys: 100, keyPattern: /^[\x21-\x7e]{1,200}$/ }),
    }),
    organization: ({ body }) => body.organizationId,
    errors: ["identity_provider_required", "identity_provider_reserved", "organization_not_found"],
    async handler(ctx, { body }) {
      const identity = ctx.resolveIdentity(body.identity, "identity");
      return computeAuthorizationSnapshot(ctx.engine, ctx.config.storage.features, {
        identity,
        organizationId: body.organizationId,
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
        ...(body.features !== undefined ? { features: body.features } : {}),
      });
    },
  }),
];
