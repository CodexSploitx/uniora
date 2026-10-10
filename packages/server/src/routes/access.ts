import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { id } from "./common.js";
import { etag, runAccess, versioned } from "./delegated.js";
import { MemberOut, RoleVersionedOut } from "./schemas.js";

const org = id("The organization.", "org_acme");
const member = id("The membership (not the user id): `members.list` shows both.", "mem_ana");
const role = id("The role.", "role_viewer");
const reason = s.optional(s.string({ min: 1, max: 500, description: "Why. Kept in the audit log." }));

const memberParams = s.object({ organizationId: org, membershipId: member });
const memberRoleParams = s.object({ organizationId: org, membershipId: member, roleId: role });
const roleParams = s.object({ organizationId: org, roleId: role });
const rolePermissionParams = s.object({ organizationId: org, roleId: role, permissionKey: id("The permission key.", "reports.read") });

const RULES = ["access_self_change", "access_escalation", "access_target_stronger", "access_owner_protected"] as const;
const COMMON = ["actor_required", "identity_provider_required", "identity_provider_reserved", "actor_token_unsupported", "forbidden", "organization_not_found", ...RULES] as const;
const MEMBER_ERRORS = [...COMMON, "membership_not_found", "membership_version_conflict"] as const;
const ROLE_ERRORS = [...COMMON, "role_not_found", "role_version_conflict"] as const;

const DELEGATED_NOTE =
  " A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it (the four anti-escalation rules apply to them).";

export const accessRoutes = [
  defineRoute({
    id: "members.assignRole",
    method: "PUT",
    path: "/v1/organizations/:organizationId/members/:membershipId/roles/:roleId",
    summary: "Give a member a role",
    description: `The actor can only give a role if they hold every permission in it, and never to themselves. Idempotent: giving a role the member already has changes nothing. Send \`If-Match\` with the member's version to refuse a stale edit.${DELEGATED_NOTE}`,
    scope: "members:write",
    delegated: true,
    params: memberRoleParams,
    response: MemberOut,
    organization: ({ params }) => params.organizationId,
    errors: [...MEMBER_ERRORS, "role_not_found"],
    async handler(ctx, { params }) {
      const result = (await runAccess(ctx, "assignRole", params.organizationId, { membershipId: params.membershipId, roleId: params.roleId, ...versioned(ctx) })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "members.unassignRole",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/members/:membershipId/roles/:roleId",
    summary: "Take a role away from a member",
    description: `The member keeps their other roles. The Owner role does not move through here.${DELEGATED_NOTE}`,
    scope: "members:write",
    delegated: true,
    params: memberRoleParams,
    response: MemberOut,
    organization: ({ params }) => params.organizationId,
    errors: [...MEMBER_ERRORS, "role_not_found"],
    async handler(ctx, { params }) {
      const result = (await runAccess(ctx, "unassignRole", params.organizationId, { membershipId: params.membershipId, roleId: params.roleId, ...versioned(ctx) })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "members.block",
    method: "POST",
    path: "/v1/organizations/:organizationId/members/:membershipId/block",
    summary: "Block a member",
    description: `A blocked member keeps their roles and history but is denied every check until unblocked.${DELEGATED_NOTE}`,
    scope: "members:write",
    delegated: true,
    params: memberParams,
    body: s.object({ reason }),
    response: MemberOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    async handler(ctx, { params, body }) {
      const result = (await runAccess(ctx, "blockMember", params.organizationId, { membershipId: params.membershipId, ...body, ...versioned(ctx) })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "members.suspend",
    method: "POST",
    path: "/v1/organizations/:organizationId/members/:membershipId/suspend",
    summary: "Suspend a member until a date",
    description: `Like a block that ends by itself at \`until\`, with no job to run.${DELEGATED_NOTE}`,
    scope: "members:write",
    delegated: true,
    params: memberParams,
    body: s.object({ until: s.date({ description: "When the suspension ends. Must be in the future." }), reason }),
    response: MemberOut,
    organization: ({ params }) => params.organizationId,
    errors: [...MEMBER_ERRORS, "membership_block_until_invalid"],
    async handler(ctx, { params, body }) {
      const result = (await runAccess(ctx, "suspendMember", params.organizationId, { membershipId: params.membershipId, ...body, ...versioned(ctx) })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "members.unblock",
    method: "POST",
    path: "/v1/organizations/:organizationId/members/:membershipId/unblock",
    summary: "Lift a block or a suspension",
    description: `The member is evaluated normally again.${DELEGATED_NOTE}`,
    scope: "members:write",
    delegated: true,
    params: memberParams,
    response: MemberOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    async handler(ctx, { params }) {
      const result = (await runAccess(ctx, "unblockMember", params.organizationId, { membershipId: params.membershipId, ...versioned(ctx) })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "members.remove",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/members/:membershipId",
    summary: "Remove a member from the organization",
    description: `Their team memberships go with it. The last Owner cannot be removed. Leaving by one's own choice is not a delegated call.${DELEGATED_NOTE}`,
    scope: "members:write",
    delegated: true,
    params: memberParams,
    response: s.object({ removed: s.bool() }),
    organization: ({ params }) => params.organizationId,
    errors: [...MEMBER_ERRORS, "last_owner"],
    handler: async (ctx, { params }) => (await runAccess(ctx, "removeMember", params.organizationId, { membershipId: params.membershipId })) as never,
  }),

  defineRoute({
    id: "roles.create",
    method: "POST",
    path: "/v1/organizations/:organizationId/roles",
    summary: "Create a role",
    description: `The actor can only put into the role permissions they hold themselves. The key is derived from the name unless given.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    status: 201,
    params: s.object({ organizationId: org }),
    body: s.object({
      id: s.optional(id("Your own id for the role; generated when omitted.")),
      name: s.string({ min: 1, max: 255, description: "Shown to people.", example: "Support agent" }),
      key: s.optional(s.string({ min: 1, max: 100, description: "Stable and URL-safe, unique in the organization. Cannot change later." })),
      description: s.optional(s.string({ min: 1, max: 500 })),
      permissionKeys: s.optional(s.array(id("A permission key."), { max: 200 })),
    }),
    response: RoleVersionedOut,
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "role_exists", "role_key_exists", "permission_not_found"],
    async handler(ctx, { params, body }) {
      const result = (await runAccess(ctx, "createRole", params.organizationId, body)) as { id: string; version: number };
      ctx.setHeader("ETag", etag(result.version));
      ctx.setHeader("Location", `/v1/organizations/${encodeURIComponent(params.organizationId)}/roles/${encodeURIComponent(result.id)}/permissions`);
      return result as never;
    },
  }),

  defineRoute({
    id: "roles.update",
    method: "PATCH",
    path: "/v1/organizations/:organizationId/roles/:roleId",
    summary: "Rename a role or change its description",
    description: `Send \`description: null\` to clear it. The key never changes. Send \`If-Match\` with the role's version to refuse a stale edit.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    params: roleParams,
    body: s.object({ name: s.optional(s.string({ min: 1, max: 255 })), description: s.optional(s.nullable(s.string({ min: 1, max: 500 }))) }),
    response: RoleVersionedOut,
    organization: ({ params }) => params.organizationId,
    errors: ROLE_ERRORS,
    async handler(ctx, { params, body }) {
      const result = (await runAccess(ctx, "updateRole", params.organizationId, { roleId: params.roleId, ...body, ...versioned(ctx) })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "roles.setPermissions",
    method: "PUT",
    path: "/v1/organizations/:organizationId/roles/:roleId/permissions",
    summary: "Make a role hold exactly these permissions",
    description: `Replaces the role's permissions. The actor must hold the role's current permissions and every new one.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    params: roleParams,
    body: s.object({ permissionKeys: s.array(id("A permission key."), { max: 200 }) }),
    response: s.object({ granted: s.array(s.string({ max: 200 }), { max: 1000 }), revoked: s.array(s.string({ max: 200 }), { max: 1000 }) }),
    organization: ({ params }) => params.organizationId,
    errors: [...ROLE_ERRORS, "permission_not_found"],
    handler: async (ctx, { params, body }) => (await runAccess(ctx, "setRolePermissions", params.organizationId, { roleId: params.roleId, ...body, ...versioned(ctx) })) as never,
  }),

  defineRoute({
    id: "roles.grantPermission",
    method: "PUT",
    path: "/v1/organizations/:organizationId/roles/:roleId/permissions/:permissionKey",
    summary: "Add one permission to a role",
    description: `Idempotent. The actor must hold the permission themselves.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    params: rolePermissionParams,
    response: RoleVersionedOut,
    organization: ({ params }) => params.organizationId,
    errors: [...ROLE_ERRORS, "permission_not_found"],
    async handler(ctx, { params }) {
      const result = (await runAccess(ctx, "grantRolePermission", params.organizationId, { roleId: params.roleId, permissionKey: params.permissionKey })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "roles.revokePermission",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/roles/:roleId/permissions/:permissionKey",
    summary: "Take one permission away from a role",
    description: `Idempotent.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    params: rolePermissionParams,
    response: RoleVersionedOut,
    organization: ({ params }) => params.organizationId,
    errors: ROLE_ERRORS,
    async handler(ctx, { params }) {
      const result = (await runAccess(ctx, "revokeRolePermission", params.organizationId, { roleId: params.roleId, permissionKey: params.permissionKey })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "roles.clone",
    method: "POST",
    path: "/v1/organizations/:organizationId/roles/:roleId/clone",
    summary: "Copy a role under a new name",
    description: `The copy is never a system role and the Owner role cannot be cloned. The actor must hold every permission the role holds.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    status: 201,
    params: roleParams,
    body: s.object({
      id: s.optional(id("Your own id for the copy; generated when omitted.")),
      name: s.string({ min: 1, max: 255 }),
      key: s.optional(s.string({ min: 1, max: 100 })),
      description: s.optional(s.string({ min: 1, max: 500 })),
    }),
    response: RoleVersionedOut,
    organization: ({ params }) => params.organizationId,
    errors: [...ROLE_ERRORS, "role_exists", "role_key_exists", "owner_role_protected"],
    async handler(ctx, { params, body }) {
      const result = (await runAccess(ctx, "cloneRole", params.organizationId, { roleId: params.roleId, ...body })) as { version: number };
      ctx.setHeader("ETag", etag(result.version));
      return result as never;
    },
  }),

  defineRoute({
    id: "roles.delete",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/roles/:roleId",
    summary: "Delete a role",
    description: `\`members\` says what happens to the people who still hold it: \`detach\` (default) takes it from them, \`reject\` refuses while anyone holds it, and \`reassignTo\` gives them another role of the same organization. The Owner role and system roles cannot be deleted.${DELEGATED_NOTE}`,
    scope: "roles:write",
    delegated: true,
    params: roleParams,
    query: s.object({
      members: s.optional(s.enum(["detach", "reject"] as const, { description: "What to do with the holders." })),
      reassignTo: s.optional(id("Give the holders this role instead.")),
    }),
    refine: ({ query }) => (query.members !== undefined && query.reassignTo !== undefined ? [{ path: "reassignTo", code: "too_many" as const }] : []),
    response: s.object({ deleted: s.bool() }),
    organization: ({ params }) => params.organizationId,
    errors: [...ROLE_ERRORS, "role_in_use", "role_system_protected", "owner_role_protected"],
    handler: async (ctx, { params, query }) =>
      (await runAccess(ctx, "deleteRole", params.organizationId, {
        roleId: params.roleId,
        ...(query.reassignTo !== undefined ? { members: { reassignTo: query.reassignTo } } : query.members !== undefined ? { members: query.members } : {}),
      })) as never,
  }),
];
