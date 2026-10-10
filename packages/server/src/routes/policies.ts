import type { Policy, PolicyRevision } from "@uniora/core";
import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { IdentityOutput, PageQuery, decodeCursor, id, pageOf, pageSize, toPage, IdentityInput } from "./common.js";
import { runPolicy, versioned, withEtag } from "./delegated.js";
import { ContextInput, ResourceInput, SessionInput } from "./schemas.js";

const POLICY_EFFECTS = ["deny", "require"] as const;
const POLICY_KINDS = ["access", "resource", "scope", "feature", "contextual", "sensitive"] as const;
const POLICY_STATUSES = ["draft", "active", "disabled", "retired"] as const;

const org = id("The organization.", "org_acme");
const policyId = id("The policy.", "pol_1");
const orgParams = s.object({ organizationId: org });
const policyParams = s.object({ organizationId: org, policyId });
const reason = s.optional(s.string({ min: 1, max: 500, description: "Why. Kept in the audit log." }));
const note = s.optional(s.string({ min: 1, max: 500, description: "A note kept with this revision of the definition." }));

/** A policy definition is a JSON object the policy language validates strictly (unknown fields, bad operators and oversize rules are refused with `policy_definition_invalid`). */
const Definition = (description: string) =>
  s.record(s.json({ maxDepth: 12, maxNodes: 5000, maxString: 2000 }), { maxKeys: 30, keyPattern: /^[A-Za-z][A-Za-z0-9_]{0,63}$/, description });

const Moment = s.object({ at: s.date(), by: IdentityOutput, reason: s.optional(s.string({ max: 500 })) });

const PolicyOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  key: s.string({ max: 200, description: "Stable handle, unique in the organization for all time." }),
  name: s.string({ max: 255 }),
  description: s.optional(s.string({ max: 1000 })),
  kind: s.enum(POLICY_KINDS),
  effect: s.enum(POLICY_EFFECTS, { description: "A policy only restricts: `deny` refuses when the condition holds, `require` refuses unless it holds." }),
  status: s.enum(POLICY_STATUSES),
  revision: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "The revision of the definition. Decisions record it." }),
  definition: Definition("The normalized definition."),
  definitionHash: s.string({ max: 128 }),
  createdAt: s.date(),
  createdBy: IdentityOutput,
  updatedAt: s.date(),
  statusChange: s.optional(Moment),
  activatedAt: s.optional(s.date()),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Send it back as `If-Match` to refuse changes made from a stale copy." }),
});

const RevisionOut = s.object({
  policyId: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  revision: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  definition: Definition("The definition at this revision."),
  definitionHash: s.string({ max: 128 }),
  createdAt: s.date(),
  createdBy: IdentityOutput,
  note: s.optional(s.string({ max: 500 })),
});

const Free = s.json({ maxDepth: 8, maxNodes: 5000, maxString: 2000 });

const SimulationOut = s.object({
  allowed: s.bool({ description: "Check this, not `decision`." }),
  decision: s.enum(["allow", "deny", "indeterminate"] as const),
  reason: s.string({ max: 64, description: "Why. Stable codes; only ever added." }),
  organizationId: s.string({ max: 200 }),
  permission: s.string({ max: 200 }),
  via: s.optional(s.enum(["membership", "support_grant"] as const)),
  policyRevision: s.nullable(s.int({ min: 0, max: Number.MAX_SAFE_INTEGER })),
  stepUp: s.optional(s.object({ policyKeys: s.array(s.string({ max: 200 }), { max: 100 }) })),
  policies: s.array(Free, { max: 500, description: "Every policy that applied, with the revision and what it said." }),
  evaluatedAt: s.date(),
});

const COMMON = ["actor_required", "identity_provider_required", "identity_provider_reserved", "actor_token_unsupported", "forbidden", "organization_not_found"] as const;
const POLICY_ERRORS = [...COMMON, "policy_not_found", "policy_version_conflict"] as const;
const WRITE_ERRORS = [...POLICY_ERRORS, "policy_definition_invalid", "policy_transition_invalid", "policy_retired", "policy_separation_of_duties"] as const;

const DELEGATED_NOTE =
  " A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user holds the policy permission (`policies.read`, `policies.manage`, `policies.activate`). Policy administration is never subject to policies.";

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const idCursor = (value: unknown): string | undefined => (typeof value === "object" && value !== null && typeof (value as { after?: unknown }).after === "string" ? (value as { after: string }).after : undefined);
const revisionCursor = (value: unknown): number | undefined => (typeof value === "object" && value !== null && isPositive((value as { before?: unknown }).before) ? (value as { before: number }).before : undefined);

export const policyRoutes = [
  defineRoute({
    id: "policies.list",
    method: "GET",
    path: "/v1/organizations/:organizationId/policies",
    summary: "List an organization's policies",
    description: `Ordered by id. \`q\` matches the key or the name.${DELEGATED_NOTE}`,
    scope: "organizations:read",
    delegated: true,
    params: orgParams,
    query: s.object({
      ...PageQuery,
      status: s.optional(s.enum(POLICY_STATUSES)),
      kind: s.optional(s.enum(POLICY_KINDS)),
      effect: s.optional(s.enum(POLICY_EFFECTS)),
    }),
    response: pageOf(PolicyOut),
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "invalid_cursor"],
    async handler(ctx, { params, query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, idCursor);
      const rows = (await runPolicy(ctx, "listPolicies", params.organizationId, {
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        ...(query.effect !== undefined ? { effect: query.effect } : {}),
      })) as Policy[];
      return toPage(rows, limit, (last) => ({ after: last.id })) as never;
    },
  }),

  defineRoute({
    id: "policies.get",
    method: "GET",
    path: "/v1/organizations/:organizationId/policies/:policyId",
    summary: "Get a policy",
    description: `A policy of another organization answers exactly like one that does not exist.${DELEGATED_NOTE}`,
    scope: "organizations:read",
    delegated: true,
    params: policyParams,
    response: PolicyOut,
    organization: ({ params }) => params.organizationId,
    errors: POLICY_ERRORS,
    handler: async (ctx, { params }) => withEtag(ctx, await runPolicy(ctx, "getPolicy", params.organizationId, { policyId: params.policyId })),
  }),

  defineRoute({
    id: "policies.revisions",
    method: "GET",
    path: "/v1/organizations/:organizationId/policies/:policyId/revisions",
    summary: "The history of a policy's definition",
    description: `Newest first. Each revision is immutable; decisions record the revision they used.${DELEGATED_NOTE}`,
    scope: "organizations:read",
    delegated: true,
    params: policyParams,
    query: s.object({ limit: PageQuery.limit, cursor: PageQuery.cursor }),
    response: pageOf(RevisionOut),
    organization: ({ params }) => params.organizationId,
    errors: [...POLICY_ERRORS, "invalid_cursor"],
    async handler(ctx, { params, query }) {
      const limit = pageSize(ctx, query.limit);
      const before = decodeCursor(query.cursor, revisionCursor);
      const rows = (await runPolicy(ctx, "listRevisions", params.organizationId, { policyId: params.policyId, limit: limit + 1, ...(before !== undefined ? { before } : {}) })) as PolicyRevision[];
      return toPage(rows, limit, (last) => ({ before: last.revision })) as never;
    },
  }),

  defineRoute({
    id: "policies.create",
    method: "POST",
    path: "/v1/organizations/:organizationId/policies",
    summary: "Create a policy as a draft",
    description: `A draft is never evaluated. Its id is generated by the server. Needs \`policies.manage\`.${DELEGATED_NOTE}`,
    scope: "policies:write",
    delegated: true,
    status: 201,
    params: orgParams,
    body: s.object({
      key: s.string({ min: 1, max: 100, description: "Stable handle, unique in the organization for all time.", example: "locked-vehicle" }),
      name: s.string({ min: 1, max: 255 }),
      description: s.optional(s.string({ min: 1, max: 1000 })),
      definition: Definition("The rule, in the policy language. `POST .../policy-validations` checks one without saving it."),
      note,
    }),
    response: PolicyOut,
    organization: ({ params }) => params.organizationId,
    errors: [...WRITE_ERRORS, "policy_key_taken", "policy_limit_reached"],
    async handler(ctx, { params, body }) {
      const created = withEtag<{ id: string }>(ctx, await runPolicy(ctx, "createPolicy", params.organizationId, body));
      ctx.setHeader("Location", `/v1/organizations/${encodeURIComponent(params.organizationId)}/policies/${encodeURIComponent(created.id)}`);
      return created as never;
    },
  }),

  defineRoute({
    id: "policies.update",
    method: "PATCH",
    path: "/v1/organizations/:organizationId/policies/:policyId",
    summary: "Edit a policy",
    description: `Metadata and, for a draft or disabled policy, the definition. Changing the definition of an ACTIVE policy also needs \`policies.activate\`. Send \`If-Match\` to refuse a stale edit.${DELEGATED_NOTE}`,
    scope: "policies:write",
    delegated: true,
    params: policyParams,
    body: s.object({
      name: s.optional(s.string({ min: 1, max: 255 })),
      description: s.optional(s.nullable(s.string({ min: 1, max: 1000 }))),
      definition: s.optional(Definition("The new rule. It becomes a new revision.")),
      note,
    }),
    response: PolicyOut,
    organization: ({ params }) => params.organizationId,
    errors: WRITE_ERRORS,
    handler: async (ctx, { params, body }) => withEtag(ctx, await runPolicy(ctx, "updatePolicy", params.organizationId, { policyId: params.policyId, ...body, ...versioned(ctx) })),
  }),

  ...(["activate", "disable", "retire"] as const).map((action) =>
    defineRoute({
      id: `policies.${action}`,
      method: "POST",
      path: `/v1/organizations/:organizationId/policies/:policyId/${action}`,
      summary: { activate: "Put a policy live", disable: "Switch a policy off", retire: "Retire a policy for good" }[action],
      description: `${{ activate: "From now on it is evaluated on every matching request.", disable: "It is no longer evaluated and can be activated again.", retire: "It is no longer evaluated, kept for the record, and can never be activated again." }[action]} Needs \`policies.activate\`.${DELEGATED_NOTE}`,
      scope: "policies:write",
      delegated: true,
      params: policyParams,
      body: s.object({ reason }),
      response: PolicyOut,
      organization: ({ params }) => params.organizationId,
      errors: WRITE_ERRORS,
      handler: async (ctx, { params, body }) => withEtag(ctx, await runPolicy(ctx, `${action}Policy`, params.organizationId, { policyId: params.policyId, ...body, ...versioned(ctx) })),
    }),
  ),

  defineRoute({
    id: "policies.delete",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/policies/:policyId",
    summary: "Delete a draft",
    description: `Only a policy that has never been active can be deleted; retire the others.${DELEGATED_NOTE}`,
    scope: "policies:write",
    delegated: true,
    params: policyParams,
    response: s.object({ deleted: s.bool() }),
    organization: ({ params }) => params.organizationId,
    errors: [...POLICY_ERRORS, "policy_not_draft"],
    handler: async (ctx, { params }) => (await runPolicy(ctx, "deletePolicy", params.organizationId, { policyId: params.policyId })) as never,
  }),

  defineRoute({
    id: "policies.validate",
    method: "POST",
    path: "/v1/organizations/:organizationId/policy-validations",
    summary: "Check a definition without saving it",
    description: `Answers with the normalized definition, its hash and what it reads, or \`policy_definition_invalid\`. Writes nothing. Needs \`policies.read\`.${DELEGATED_NOTE}`,
    scope: "organizations:read",
    write: false,
    delegated: true,
    params: orgParams,
    body: s.object({ definition: Definition("The rule to check.") }),
    response: s.object({ definition: Definition("The normalized definition."), hash: s.string({ max: 128 }), analysis: Free }),
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "policy_definition_invalid"],
    handler: async (ctx, { params, body }) => (await runPolicy(ctx, "validatePolicy", params.organizationId, body)) as never,
  }),

  defineRoute({
    id: "policies.simulate",
    method: "POST",
    path: "/v1/organizations/:organizationId/policy-simulations",
    summary: "What would be decided?",
    description: `Answers \`authorize\` for any member and any resource, optionally with a candidate definition in place of a stored one. Writes nothing. Needs \`policies.read\`. \`identity\` is the person the question is about, not the actor.${DELEGATED_NOTE}`,
    scope: "organizations:read",
    write: false,
    delegated: true,
    params: orgParams,
    body: s.object({
      identity: IdentityInput,
      permission: s.string({ min: 1, max: 200, example: "vehicles.delete" }),
      teamId: s.optional(id("Ask inside this team.")),
      resource: ResourceInput,
      context: ContextInput,
      session: SessionInput,
      at: s.optional(s.date({ description: "Pretend it is this moment (for `environment.*` conditions)." })),
      requireApplicablePolicy: s.optional(s.bool()),
      candidate: s.optional(s.object({ policyId: s.optional(id("Replace this policy's definition.")), definition: Definition("The definition to try.") })),
    }),
    response: SimulationOut,
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "policy_definition_invalid"],
    async handler(ctx, { params, body }) {
      const identity = ctx.resolveIdentity(body.identity, "identity");
      return (await runPolicy(ctx, "simulate", params.organizationId, { ...body, identity })) as never;
    },
  }),
];

