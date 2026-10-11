import type { Organization, OrganizationCursor, OrganizationStatus, PlatformMember, PlatformRole } from "@uniora/core";
import { runPlatformCommand } from "@uniora/core";
import { errors } from "../errors.js";
import type { RouteContext } from "../route.js";
import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { IdentityOutput, PageQuery, decodeCursor, id, pageOf, pageSize, toPage } from "./common.js";
import { toJson, versioned, withEtag } from "./delegated.js";
import { ORG_STATUSES, OrganizationOut } from "./schemas.js";

const PLATFORM_NOTE =
  " A PLATFORM call: it speaks for the operator in the `Uniora-Actor-Token` header (a token from one of the server's platform providers, never an asserted user), needs the `platform:admin` scope on a client with every organization, and succeeds only if that operator holds the platform permission. A change also needs a recent sign-in with a second factor in that token (`428 platform_step_up_required` otherwise).";

const PLATFORM_ERRORS = ["platform_not_configured", "actor_token_required", "actor_token_invalid", "actor_token_unavailable", "forbidden"] as const;
const READ_ERRORS = [...PLATFORM_ERRORS, "invalid_cursor"] as const;
const WRITE_ERRORS = [...PLATFORM_ERRORS, "platform_step_up_required", "platform_invalid"] as const;

const Moment = s.object({ at: s.date(), by: IdentityOutput, reason: s.optional(s.string({ max: 500 })) });
const Version = s.int({ min: 1, max: Number.MAX_SAFE_INTEGER, description: "Send it back as `If-Match` to refuse changes made from a stale copy." });

export const PlatformRoleOut = s.object({
  id: s.string({ max: 200 }),
  key: s.string({ max: 200 }),
  name: s.string({ max: 200 }),
  description: s.optional(s.string({ max: 1000 })),
  permissions: s.array(s.string({ max: 200 }), { max: 500, description: "`platform.*` keys. A trailing `.*` covers everything under that prefix." }),
  isSystem: s.bool({ description: "Created by UNIORA itself (`platform_admin`); it cannot be edited, renamed or deleted." }),
  createdAt: s.date(),
  updatedAt: s.date(),
  version: Version,
});

export const PlatformMemberOut = s.object({
  id: s.string({ max: 200 }),
  identity: IdentityOutput,
  status: s.enum(["active", "suspended"] as const),
  roleIds: s.array(s.string({ max: 200 }), { max: 100 }),
  createdAt: s.date(),
  updatedAt: s.date(),
  addedBy: IdentityOutput,
  statusChange: s.optional(Moment),
  version: Version,
});

export const SupportGrantOut = s.object({
  id: s.string({ max: 200 }),
  organizationId: s.string({ max: 200 }),
  operator: IdentityOutput,
  grantedBy: IdentityOutput,
  reason: s.string({ max: 500 }),
  permissions: s.array(s.string({ max: 200 }), { max: 50 }),
  createdAt: s.date(),
  expiresAt: s.date(),
  revokedAt: s.optional(s.date()),
  revokedBy: s.optional(IdentityOutput),
});

const roleParams = s.object({ roleId: id("A platform role.", "prole_support") });
const memberParams = s.object({ memberId: id("A platform member.", "pmem_ana") });
const memberRoleParams = s.object({ memberId: id("A platform member.", "pmem_ana"), roleId: id("A platform role.", "prole_support") });
const organizationParams = s.object({ organizationId: id("The organization.", "org_acme") });
const grantParams = s.object({ grantId: id("A support grant.", "sgr_1") });
const permissionKeys = (description: string) => s.array(s.string({ min: 1, max: 200 }), { max: 100, description });
const reason = s.optional(s.string({ min: 1, max: 500, description: "Why. Kept in the audit log." }));

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const afterCursor = (value: unknown): string | undefined => (typeof value === "object" && value !== null && isString((value as { after?: unknown }).after) ? (value as { after: string }).after : undefined);
const momentCursor = (value: unknown): OrganizationCursor | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { createdAt, id: cursorId } = value as { createdAt?: unknown; id?: unknown };
  if (typeof createdAt !== "string" || !isString(cursorId)) return undefined;
  const time = Date.parse(createdAt);
  return Number.isFinite(time) ? { createdAt: new Date(time), id: cursorId } : undefined;
};

/** Runs a platform command as the operator the token names. The route fixes the command; `params` was parsed by the route's strict schema and is checked again by the command layer. */
function run(ctx: RouteContext, command: string, params: object = {}): Promise<unknown> {
  const { actor, service } = ctx.platform();
  return runPlatformCommand(service, command, { actor }, toJson(params));
}

export const platformRoutes = [
  defineRoute({
    id: "platformRoles.list",
    method: "GET",
    path: "/v1/platform/roles",
    summary: "List platform roles",
    description: `Ordered by id.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    query: s.object({ limit: PageQuery.limit, cursor: PageQuery.cursor }),
    response: pageOf(PlatformRoleOut),
    errors: READ_ERRORS,
    async handler(ctx, { query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, afterCursor);
      const rows = (await run(ctx, "listRoles", { limit: limit + 1, ...(after ? { after } : {}) })) as PlatformRole[];
      return toPage(rows, limit, (last) => ({ after: last.id })) as never;
    },
  }),

  defineRoute({
    id: "platformRoles.create",
    method: "POST",
    path: "/v1/platform/roles",
    summary: "Create a platform role",
    description: `A role holds \`platform.*\` permissions, only ones the operator holds themselves.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    etag: true,
    status: 201,
    body: s.object({
      key: s.string({ min: 2, max: 63, pattern: /^[a-z][a-z0-9_-]{1,62}$/, description: "Stable handle, unique across the platform.", example: "support" }),
      name: s.string({ min: 1, max: 200, example: "Support" }),
      description: s.optional(s.string({ min: 1, max: 1000 })),
      permissions: permissionKeys("`platform.*` keys."),
    }),
    response: PlatformRoleOut,
    errors: [...WRITE_ERRORS, "platform_role_exists", "platform_role_invalid", "platform_permission_invalid"],
    async handler(ctx, { body }) {
      return withEtag(ctx, await run(ctx, "createRole", body));
    },
  }),

  defineRoute({
    id: "platformRoles.update",
    method: "PATCH",
    path: "/v1/platform/roles/:roleId",
    summary: "Edit a platform role",
    description: `Send only what changes. Send \`If-Match\` with the role's version to refuse a stale edit. A system role cannot be edited.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    ifMatch: true,
    etag: true,
    params: roleParams,
    body: s.object({
      name: s.optional(s.string({ min: 1, max: 200 })),
      description: s.optional(s.nullable(s.string({ min: 1, max: 1000 }))),
      permissions: s.optional(permissionKeys("The role will hold exactly these `platform.*` keys.")),
    }),
    response: PlatformRoleOut,
    errors: [...WRITE_ERRORS, "platform_role_not_found", "platform_role_invalid", "platform_permission_invalid", "platform_version_conflict"],
    async handler(ctx, { params, body }) {
      return withEtag(ctx, await run(ctx, "updateRole", { roleId: params.roleId, ...body, ...versioned(ctx) }));
    },
  }),

  defineRoute({
    id: "platformRoles.delete",
    method: "DELETE",
    path: "/v1/platform/roles/:roleId",
    summary: "Delete a platform role",
    description: `Not a system role, and not one a member still holds.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    params: roleParams,
    response: s.object({ deleted: s.bool() }),
    errors: [...WRITE_ERRORS, "platform_role_not_found", "platform_role_in_use"],
    handler: async (ctx, { params }) => (await run(ctx, "deleteRole", { roleId: params.roleId })) as never,
  }),

  defineRoute({
    id: "platformMembers.list",
    method: "GET",
    path: "/v1/platform/members",
    summary: "List platform members",
    description: `The people who administer the platform, unrelated to any organization's members. Ordered by id.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    query: s.object({ limit: PageQuery.limit, cursor: PageQuery.cursor, status: s.optional(s.enum(["active", "suspended"] as const)), roleId: s.optional(id("Only members holding this role.")) }),
    response: pageOf(PlatformMemberOut),
    errors: READ_ERRORS,
    async handler(ctx, { query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, afterCursor);
      const rows = (await run(ctx, "listMembers", {
        limit: limit + 1,
        ...(after ? { after } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.roleId !== undefined ? { roleId: query.roleId } : {}),
      })) as PlatformMember[];
      return toPage(rows, limit, (last) => ({ after: last.id })) as never;
    },
  }),

  defineRoute({
    id: "platformMembers.add",
    method: "POST",
    path: "/v1/platform/members",
    summary: "Add a platform member",
    description: `\`provider\` is the label of one of the server's platform providers; omit it to use the operator's own. Nobody can add themselves.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    etag: true,
    status: 201,
    body: s.object({
      provider: s.optional(s.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, description: "A platform provider label; defaults to the operator's.", example: "staff" })),
      subject: s.string({ min: 1, max: 500, description: "The person's stable id in the staff identity provider.", example: "ana-staff" }),
      roleIds: s.array(id("A platform role."), { max: 10 }),
    }),
    response: PlatformMemberOut,
    errors: [...WRITE_ERRORS, "platform_member_exists", "platform_member_invalid", "platform_role_not_found"],
    async handler(ctx, { body }) {
      const { actor, providers } = ctx.platform();
      const provider = body.provider ?? actor.provider;
      if (!providers.has(provider)) throw errors.invalidRequest([{ path: "provider", code: "enum" }]);
      return withEtag(ctx, await run(ctx, "addMember", { provider, subject: body.subject, roleIds: body.roleIds }));
    },
  }),

  defineRoute({
    id: "platformMembers.suspend",
    method: "POST",
    path: "/v1/platform/members/:memberId/suspend",
    summary: "Suspend a platform member",
    description: `The member keeps their record and roles but is denied everything. The last active administrator cannot be suspended, and nobody suspends themselves.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    ifMatch: true,
    etag: true,
    params: memberParams,
    body: s.object({ reason }),
    response: PlatformMemberOut,
    errors: [...WRITE_ERRORS, "platform_member_not_found", "platform_last_admin", "platform_version_conflict"],
    async handler(ctx, { params, body }) {
      return withEtag(ctx, await run(ctx, "suspendMember", { memberId: params.memberId, ...(body.reason !== undefined ? { reason: body.reason } : {}), ...versioned(ctx) }));
    },
  }),

  defineRoute({
    id: "platformMembers.reactivate",
    method: "POST",
    path: "/v1/platform/members/:memberId/reactivate",
    summary: "Reactivate a platform member",
    description: `Lifts a suspension.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    ifMatch: true,
    etag: true,
    params: memberParams,
    response: PlatformMemberOut,
    errors: [...WRITE_ERRORS, "platform_member_not_found", "platform_version_conflict"],
    async handler(ctx, { params }) {
      return withEtag(ctx, await run(ctx, "reactivateMember", { memberId: params.memberId, ...versioned(ctx) }));
    },
  }),

  defineRoute({
    id: "platformMembers.remove",
    method: "DELETE",
    path: "/v1/platform/members/:memberId",
    summary: "Remove a platform member",
    description: `The last active administrator cannot be removed, and nobody removes themselves.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    params: memberParams,
    response: s.object({ removed: s.bool() }),
    errors: [...WRITE_ERRORS, "platform_member_not_found", "platform_last_admin"],
    handler: async (ctx, { params }) => (await run(ctx, "removeMember", { memberId: params.memberId })) as never,
  }),

  defineRoute({
    id: "platformMembers.assignRole",
    method: "PUT",
    path: "/v1/platform/members/:memberId/roles/:roleId",
    summary: "Give a platform member a role",
    description: `Only a role whose permissions the operator holds themselves, and never to themselves.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    ifMatch: true,
    etag: true,
    params: memberRoleParams,
    response: PlatformMemberOut,
    errors: [...WRITE_ERRORS, "platform_member_not_found", "platform_role_not_found", "platform_version_conflict"],
    async handler(ctx, { params }) {
      return withEtag(ctx, await run(ctx, "assignRole", { memberId: params.memberId, roleId: params.roleId, ...versioned(ctx) }));
    },
  }),

  defineRoute({
    id: "platformMembers.unassignRole",
    method: "DELETE",
    path: "/v1/platform/members/:memberId/roles/:roleId",
    summary: "Take a role from a platform member",
    description: `The last active administrator keeps the administrator role.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    ifMatch: true,
    etag: true,
    params: memberRoleParams,
    response: PlatformMemberOut,
    errors: [...WRITE_ERRORS, "platform_member_not_found", "platform_role_not_found", "platform_last_admin", "platform_version_conflict"],
    async handler(ctx, { params }) {
      return withEtag(ctx, await run(ctx, "unassignRole", { memberId: params.memberId, roleId: params.roleId, ...versioned(ctx) }));
    },
  }),

  defineRoute({
    id: "platformOrganizations.list",
    method: "GET",
    path: "/v1/platform/organizations",
    summary: "List every organization",
    description: `All organizations of the installation, ordered by creation time. Needs \`platform.organizations.read\`.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    query: s.object({ ...PageQuery, status: s.optional(s.enum(ORG_STATUSES)) }),
    response: pageOf(OrganizationOut),
    errors: READ_ERRORS,
    async handler(ctx, { query }) {
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, momentCursor);
      const rows = (await run(ctx, "listOrganizations", {
        limit: limit + 1,
        ...(after ? { afterCreatedAt: after.createdAt.toISOString(), afterId: after.id } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status as OrganizationStatus } : {}),
      })) as Organization[];
      return toPage(rows, limit, (last) => ({ createdAt: last.createdAt as unknown as string, id: last.id })) as never;
    },
  }),

  defineRoute({
    id: "platformOrganizations.setStatus",
    method: "PUT",
    path: "/v1/platform/organizations/:organizationId/status",
    summary: "Suspend, archive or reactivate an organization",
    description: `\`suspended\` and \`archived\` organizations are denied every decision. Also recorded in the organization's own audit trail. Needs \`platform.organizations.manage\`.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    params: organizationParams,
    body: s.object({ status: s.enum(ORG_STATUSES), reason }),
    response: OrganizationOut,
    errors: [...WRITE_ERRORS, "platform_organization_not_found"],
    handler: async (ctx, { params, body }) => (await run(ctx, "setOrganizationStatus", { organizationId: params.organizationId, status: body.status, ...(body.reason !== undefined ? { reason: body.reason } : {}) })) as never,
  }),

  defineRoute({
    id: "platformSupport.grant",
    method: "POST",
    path: "/v1/platform/support-grants",
    summary: "Open support access to an organization",
    description: `Opens a temporary, narrow, audited grant FOR THE OPERATOR in one organization: it carries an explicit list of permission keys and an expiry (in the future, at most 30 days), never the Owner role. Needs \`platform.support.grant\`.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    status: 201,
    body: s.object({
      organizationId: id("The organization to open.", "org_acme"),
      permissions: s.array(s.string({ min: 1, max: 200 }), { min: 1, max: 50, description: "Registered organization permission keys." }),
      reason: s.string({ min: 1, max: 500, description: "Why, in the operator's words. Kept in both audit trails.", example: "Ticket 4821: reports do not load" }),
      expiresAt: s.date({ description: "When the grant ends: in the future and at most 30 days away." }),
    }),
    response: SupportGrantOut,
    errors: [...WRITE_ERRORS, "support_grant_organization_unknown", "support_grant_expiry_invalid", "support_grant_permission_invalid", "support_grant_reason_invalid", "support_grant_exists"],
    handler: async (ctx, { body }) => (await run(ctx, "grantSupportAccess", body)) as never,
  }),

  defineRoute({
    id: "platformSupport.revoke",
    method: "POST",
    path: "/v1/platform/support-grants/:grantId/revoke",
    summary: "End a support grant now",
    description: `Needs \`platform.support.grant\`.${PLATFORM_NOTE}`,
    scope: "platform:admin",
    platform: true,
    allOrganizations: true,
    params: grantParams,
    response: SupportGrantOut,
    errors: [...WRITE_ERRORS, "platform_grant_not_found"],
    handler: async (ctx, { params }) => (await run(ctx, "revokeSupportAccess", { grantId: params.grantId })) as never,
  }),
];

