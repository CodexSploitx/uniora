import type { Organization, OrganizationCursor, OrganizationStatus } from "@uniora/core";
import { ApiError, errors } from "../errors.js";
import type { RouteContext } from "../route.js";
import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { IdentityOutput, PageQuery, decodeCursor, id, pageOf, pageSize, toPage } from "./common.js";

const ORG_STATUSES = ["active", "suspended", "archived"] as const;
const MEMBER_STATUSES = ["active", "suspended", "blocked"] as const;

const OrganizationOut = s.object({
  id: s.string({ max: 200 }),
  slug: s.string({ max: 200 }),
  name: s.string({ max: 200 }),
  status: s.enum(ORG_STATUSES, { description: "`suspended` and `archived` organizations are denied every decision." }),
  createdAt: s.date(),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
});

const MemberOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  identity: IdentityOutput,
  roleIds: s.array(s.string({ max: 200 }), { max: 1000 }),
  status: s.enum(MEMBER_STATUSES),
  createdAt: s.date(),
  updatedAt: s.date(),
  lastActiveAt: s.optional(s.date()),
  blocked: s.optional(s.object({ at: s.date(), until: s.optional(s.date()) }, { description: "Present while the member is blocked or suspended." })),
  version: s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Send it back as `If-Match` to refuse changes made from a stale copy." }),
});

const RoleOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  key: s.string({ max: 200 }),
  name: s.string({ max: 200 }),
  isOwnerRole: s.bool({ description: "The protected Owner role: it passes every permission check." }),
  isSystem: s.bool(),
});

const PermissionOut = s.object({
  key: s.string({ max: 200 }),
  name: s.optional(s.string({ max: 200 })),
  description: s.optional(s.string({ max: 1000 })),
  group: s.optional(s.string({ max: 200 })),
  implies: s.optional(s.array(s.string({ max: 200 }), { max: 100 })),
});

const FeatureOut = s.object({
  key: s.string({ max: 200 }),
  name: s.string({ max: 200 }),
  description: s.optional(s.string({ max: 1000 })),
  defaultEnabled: s.bool(),
  parentKey: s.optional(s.string({ max: 200 })),
});

const EffectiveFeatureOut = s.object({
  key: s.string({ max: 200 }),
  enabled: s.bool({ description: "What a check sees: the organization's override, else the default, and every parent on." }),
  reason: s.enum(["enabled", "disabled", "default", "parent_disabled"] as const),
  defaultEnabled: s.bool(),
  parentKey: s.optional(s.string({ max: 200 })),
  blockedBy: s.optional(s.string({ max: 200 })),
});

const AuditEntryOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.optional(s.string({ max: 200 })),
  actor: IdentityOutput,
  action: s.string({ max: 200 }),
  target: s.optional(s.object({ type: s.string({ max: 200 }), id: s.string({ max: 200 }) })),
  metadata: s.optional(s.json({ maxDepth: 6, maxNodes: 1000, maxString: 4000 })),
  createdAt: s.date(),
});

const orgParam = s.object({ organizationId: id("The organization.", "org_acme") });
const listQuery = s.object(PageQuery);

/** The organization, or a 404 that looks exactly like "no such organization". The allowlist was already enforced before the handler ran. */
async function requireOrganization(ctx: RouteContext, organizationId: string): Promise<Organization> {
  const organization = await ctx.config.storage.organizations.findById(organizationId);
  if (!organization) throw errors.notFound("organization_not_found");
  return organization;
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const stringCursor = (value: unknown): string | undefined => (typeof value === "object" && value !== null && isString((value as { after?: unknown }).after) ? (value as { after: string }).after : undefined);
const momentCursor = (value: unknown): OrganizationCursor | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { createdAt, id: cursorId } = value as { createdAt?: unknown; id?: unknown };
  if (typeof createdAt !== "string" || !isString(cursorId)) return undefined;
  const time = Date.parse(createdAt);
  return Number.isFinite(time) ? { createdAt: new Date(time), id: cursorId } : undefined;
};

const NO_PARAMS_ERRORS = ["invalid_request", "invalid_cursor"] as const;

export const readRoutes = [
  defineRoute({
    id: "organizations.list",
    method: "GET",
    path: "/v1/organizations",
    summary: "List organizations",
    description:
      "Only the organizations this API client may access: all of them for a client with the `*` allowlist, otherwise exactly the ones on its list. Ordered by creation time.",
    scope: "organizations:read",
    query: s.object({ ...PageQuery, status: s.optional(s.enum(ORG_STATUSES)) }),
    response: pageOf(OrganizationOut),
    errors: NO_PARAMS_ERRORS,
    async handler(ctx, { query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, momentCursor);
      const allowed = ctx.principal.client.organizations;
      let rows: Organization[];
      if (allowed === "*") {
        rows = await ctx.config.storage.organizations.search({
          limit: limit + 1,
          ...(after ? { after } : {}),
          ...(query.q !== undefined ? { query: query.q } : {}),
          ...(query.status !== undefined ? { status: query.status as OrganizationStatus } : {}),
        });
      } else {
        const needle = query.q?.toLowerCase();
        const found = await ctx.config.storage.organizations.findByIds([...allowed]);
        rows = found
          .filter((organization) => (query.status === undefined || organization.status === query.status) && (needle === undefined || organization.name.toLowerCase().includes(needle) || organization.slug.toLowerCase().includes(needle)))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
          .filter((organization) => !after || organization.createdAt.getTime() > after.createdAt.getTime() || (organization.createdAt.getTime() === after.createdAt.getTime() && organization.id > after.id))
          .slice(0, limit + 1);
      }
      return toPage(rows, limit, (last) => ({ createdAt: last.createdAt.toISOString(), id: last.id }));
    },
  }),

  defineRoute({
    id: "organizations.get",
    method: "GET",
    path: "/v1/organizations/:organizationId",
    summary: "Get an organization",
    description: "An organization outside this client's allowlist answers exactly like one that does not exist.",
    scope: "organizations:read",
    params: orgParam,
    response: OrganizationOut,
    organization: ({ params }) => params.organizationId,
    errors: ["organization_not_found"],
    handler: (ctx, { params }) => requireOrganization(ctx, params.organizationId),
  }),

  defineRoute({
    id: "members.list",
    method: "GET",
    path: "/v1/organizations/:organizationId/members",
    summary: "List an organization's members",
    description: "Ordered by member id. `q` matches the identity's subject or provider.",
    scope: "organizations:read",
    params: orgParam,
    query: s.object({ ...PageQuery, status: s.optional(s.enum(MEMBER_STATUSES)) }),
    response: pageOf(MemberOut),
    organization: ({ params }) => params.organizationId,
    errors: [...NO_PARAMS_ERRORS, "organization_not_found"],
    async handler(ctx, { params, query }) {
      await requireOrganization(ctx, params.organizationId);
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, stringCursor);
      const rows = await ctx.config.storage.memberships.search({
        organizationId: params.organizationId,
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      });
      return toPage(rows, limit, (last) => ({ after: last.id }));
    },
  }),

  defineRoute({
    id: "members.get",
    method: "GET",
    path: "/v1/organizations/:organizationId/members/:membershipId",
    summary: "Get a member",
    description: "A member of another organization answers exactly like one that does not exist.",
    scope: "organizations:read",
    params: s.object({ organizationId: id("The organization.", "org_acme"), membershipId: id("The membership.", "mem_42") }),
    response: MemberOut,
    organization: ({ params }) => params.organizationId,
    errors: ["organization_not_found", "membership_not_found"],
    async handler(ctx, { params }) {
      await requireOrganization(ctx, params.organizationId);
      const member = await ctx.config.storage.memberships.findById(params.membershipId);
      if (!member || member.organizationId !== params.organizationId) throw errors.notFound("membership_not_found");
      return member;
    },
  }),

  defineRoute({
    id: "roles.list",
    method: "GET",
    path: "/v1/organizations/:organizationId/roles",
    summary: "List an organization's roles",
    description: "Ordered by role key. `q` matches the name or the key. A role's permissions are listed by `roles.permissions`.",
    scope: "organizations:read",
    params: orgParam,
    query: listQuery,
    response: pageOf(RoleOut),
    organization: ({ params }) => params.organizationId,
    errors: [...NO_PARAMS_ERRORS, "organization_not_found"],
    async handler(ctx, { params, query }) {
      await requireOrganization(ctx, params.organizationId);
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, stringCursor);
      const rows = await ctx.config.storage.roles.search({
        organizationId: params.organizationId,
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });
      return toPage(rows, limit, (last) => ({ after: last.key }));
    },
  }),

  defineRoute({
    id: "roles.permissions",
    method: "GET",
    path: "/v1/organizations/:organizationId/roles/:roleId/permissions",
    summary: "List the permissions a role grants",
    description: "Paged, because a role can hold thousands of permissions. Ordered by permission key.",
    scope: "organizations:read",
    params: s.object({ organizationId: id("The organization.", "org_acme"), roleId: id("The role.", "role_sales") }),
    query: listQuery,
    response: pageOf(PermissionOut),
    organization: ({ params }) => params.organizationId,
    errors: [...NO_PARAMS_ERRORS, "organization_not_found", "role_not_found"],
    async handler(ctx, { params, query }) {
      await requireOrganization(ctx, params.organizationId);
      const [role] = await ctx.config.storage.roles.findSummariesByIds([params.roleId]);
      if (!role || role.organizationId !== params.organizationId) throw errors.notFound("role_not_found");
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, stringCursor);
      const rows = await ctx.config.storage.permissions.search({
        grantedToRole: params.roleId,
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });
      return toPage(rows, limit, (last) => ({ after: last.key }));
    },
  }),

  defineRoute({
    id: "permissions.list",
    method: "GET",
    path: "/v1/permissions",
    summary: "The permission catalog",
    description: "Every permission the project has registered. The catalog is shared by all organizations; it holds definitions, not who has them.",
    scope: "organizations:read",
    query: listQuery,
    response: pageOf(PermissionOut),
    errors: NO_PARAMS_ERRORS,
    async handler(ctx, { query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, stringCursor);
      const rows = await ctx.config.storage.permissions.search({
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });
      return toPage(rows, limit, (last) => ({ after: last.key }));
    },
  }),

  defineRoute({
    id: "features.list",
    method: "GET",
    path: "/v1/features",
    summary: "The feature catalog",
    description: "Every feature the project has registered, with its default and parent. What an organization has unlocked is `organizations.features`.",
    scope: "organizations:read",
    query: listQuery,
    response: pageOf(FeatureOut),
    errors: NO_PARAMS_ERRORS,
    async handler(ctx, { query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, stringCursor);
      const rows = await ctx.config.storage.features.search({
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });
      return toPage(rows, limit, (last) => ({ after: last.key }));
    },
  }),

  defineRoute({
    id: "organizations.features",
    method: "GET",
    path: "/v1/organizations/:organizationId/features",
    summary: "What an organization has unlocked",
    description: "The effective state of each feature (the override, else the default, and every parent on) and why. Paged by feature key.",
    scope: "organizations:read",
    params: orgParam,
    query: listQuery,
    response: pageOf(EffectiveFeatureOut),
    organization: ({ params }) => params.organizationId,
    errors: [...NO_PARAMS_ERRORS, "organization_not_found"],
    async handler(ctx, { params, query }) {
      await requireOrganization(ctx, params.organizationId);
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, stringCursor);
      const definitions = await ctx.config.storage.features.search({
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
      });
      const keys = definitions.slice(0, limit).map((definition) => definition.key);
      const effective = keys.length > 0 ? await ctx.config.storage.features.listEffective(params.organizationId, { keys }) : [];
      const byKey = new Map(effective.map((feature) => [feature.key, feature]));
      const rows = definitions.map((definition) => {
        const feature = byKey.get(definition.key);
        if (!feature && definitions.indexOf(definition) < limit) throw new ApiError(500, "internal_error", { detail: `no effective state for feature ${definition.key}` });
        return feature ?? { key: definition.key, enabled: false, reason: "default" as const, defaultEnabled: definition.defaultEnabled };
      });
      return toPage(rows, limit, (last) => ({ after: last.key }));
    },
  }),

  defineRoute({
    id: "audit.list",
    method: "GET",
    path: "/v1/organizations/:organizationId/audit-log",
    summary: "An organization's audit log",
    description: "Newest first. Paged with a keyset cursor, so new entries never make a page skip or repeat rows.",
    scope: "audit:read",
    params: orgParam,
    query: s.object({ limit: PageQuery.limit, cursor: PageQuery.cursor }),
    response: pageOf(AuditEntryOut),
    organization: ({ params }) => params.organizationId,
    errors: [...NO_PARAMS_ERRORS, "organization_not_found"],
    async handler(ctx, { params, query }) {
      await requireOrganization(ctx, params.organizationId);
      const limit = pageSize(ctx, query.limit);
      const before = decodeCursor(query.cursor, momentCursor);
      const rows = await ctx.config.storage.auditLogs.listByOrganization(params.organizationId, { limit: limit + 1, ...(before ? { before } : {}) });
      return toPage(rows, limit, (last) => ({ createdAt: last.createdAt.toISOString(), id: last.id }));
    },
  }),
];
