import type { Team, TeamMembership } from "@uniora/core";
import { errors } from "../errors.js";
import type { RouteContext } from "../route.js";
import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { PageQuery, decodeCursor, id, pageOf, pageSize, toPage } from "./common.js";
import { runTeam, versioned, withEtag } from "./delegated.js";
import { FreeData, TEAM_MEMBER_STATUSES, TEAM_RESPONSIBILITIES, TEAM_STATUSES, TeamMembershipOut, TeamOut } from "./schemas.js";

const org = id("The organization.", "org_acme");
const team = id("The team.", "team_barcelona");
const teamMembership = id("The team membership (not the organization membership).", "tm_1");
const roleParam = id("A role of the organization.", "role_viewer");

const orgParams = s.object({ organizationId: org });
const teamParams = s.object({ organizationId: org, teamId: team });
const teamMembershipParams = s.object({ organizationId: org, teamMembershipId: teamMembership });
const reason = s.optional(s.string({ min: 1, max: 500, description: "Why. Kept in the audit log." }));

const RULES = ["access_self_change", "access_escalation", "access_target_stronger", "access_owner_protected"] as const;
const COMMON = ["actor_required", "identity_provider_required", "identity_provider_reserved", "actor_token_unsupported", "forbidden", "organization_not_found", ...RULES] as const;
const TEAM_ERRORS = [...COMMON, "team_not_found", "team_version_conflict"] as const;
const MEMBER_ERRORS = [...COMMON, "team_membership_not_found", "team_membership_transition_invalid"] as const;

const DELEGATED_NOTE =
  " A delegated call: it speaks for the end user in the `Uniora-Actor-Subject` header, needs the `actor:assert` scope as well, and succeeds only if that user may do it.";

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const afterCursor = (value: unknown): string | undefined => (typeof value === "object" && value !== null && isString((value as { after?: unknown }).after) ? (value as { after: string }).after : undefined);

async function requireOrganization(ctx: RouteContext, organizationId: string): Promise<void> {
  if (!(await ctx.config.storage.organizations.findById(organizationId))) throw errors.notFound("organization_not_found");
}

export const teamRoutes = [
  defineRoute({
    id: "teams.list",
    method: "GET",
    path: "/v1/organizations/:organizationId/teams",
    summary: "List an organization's teams",
    description: "Ordered by id. `q` matches the name or the slug; `parentId` lists the direct sub-teams of a team.",
    scope: "organizations:read",
    params: orgParams,
    query: s.object({ ...PageQuery, status: s.optional(s.enum(TEAM_STATUSES)), parentId: s.optional(id("Only the direct sub-teams of this team.")) }),
    response: pageOf(TeamOut),
    organization: ({ params }) => params.organizationId,
    errors: ["invalid_cursor", "organization_not_found"],
    async handler(ctx, { params, query }) {
      await requireOrganization(ctx, params.organizationId);
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, afterCursor);
      const rows = await ctx.config.storage.teams.search({
        organizationId: params.organizationId,
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.parentId !== undefined ? { parentId: query.parentId } : {}),
      });
      return toPage<Team>(rows, limit, (last) => ({ after: last.id })) as never;
    },
  }),

  defineRoute({
    id: "teams.get",
    method: "GET",
    path: "/v1/organizations/:organizationId/teams/:teamId",
    summary: "Get a team",
    description: "A team of another organization answers exactly like one that does not exist.",
    scope: "organizations:read",
    params: teamParams,
    response: TeamOut,
    organization: ({ params }) => params.organizationId,
    errors: ["team_not_found", "organization_not_found"],
    async handler(ctx, { params }) {
      const found = await ctx.config.storage.teams.findById(params.organizationId, params.teamId);
      if (!found) throw errors.notFound("team_not_found");
      return withEtag(ctx, found);
    },
  }),

  defineRoute({
    id: "teams.members",
    method: "GET",
    path: "/v1/organizations/:organizationId/teams/:teamId/members",
    summary: "List the members of a team",
    description: "Team memberships, ordered by id. Filter by `status` or `responsibility`.",
    scope: "organizations:read",
    params: teamParams,
    query: s.object({
      limit: PageQuery.limit,
      cursor: PageQuery.cursor,
      status: s.optional(s.enum(TEAM_MEMBER_STATUSES)),
      responsibility: s.optional(s.enum(TEAM_RESPONSIBILITIES)),
    }),
    response: pageOf(TeamMembershipOut),
    organization: ({ params }) => params.organizationId,
    errors: ["invalid_cursor", "team_not_found", "organization_not_found"],
    async handler(ctx, { params, query }) {
      if (!(await ctx.config.storage.teams.findById(params.organizationId, params.teamId))) throw errors.notFound("team_not_found");
      const limit = pageSize(ctx, query.limit);
      const after = decodeCursor(query.cursor, afterCursor);
      const rows = await ctx.config.storage.teamMemberships.search({
        organizationId: params.organizationId,
        teamId: params.teamId,
        limit: limit + 1,
        ...(after !== undefined ? { after } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.responsibility !== undefined ? { responsibility: query.responsibility } : {}),
      });
      return toPage<TeamMembership>(rows, limit, (last) => ({ after: last.id })) as never;
    },
  }),

  defineRoute({
    id: "teams.create",
    method: "POST",
    path: "/v1/organizations/:organizationId/teams",
    summary: "Create a team",
    description: `A team is context, not authority: belonging to it grants nothing by itself. Teams nest up to 8 levels with no cycles.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    status: 201,
    params: orgParams,
    body: s.object({
      id: s.optional(id("Your own id for the team; generated when omitted.")),
      name: s.string({ min: 1, max: 255, example: "Barcelona" }),
      slug: s.optional(s.string({ min: 1, max: 100, description: "URL-safe, unique in the organization; derived from the name when omitted." })),
      externalId: s.optional(s.string({ min: 1, max: 200, description: "Your own id for the team in another system." })),
      parentId: s.optional(id("The team this one sits under.")),
      metadata: s.optional(FreeData),
      settings: s.optional(FreeData),
    }),
    response: TeamOut,
    organization: ({ params }) => params.organizationId,
    errors: [...COMMON, "team_exists", "team_slug_taken", "team_external_id_taken", "team_parent_invalid", "team_cycle", "team_too_deep"],
    async handler(ctx, { params, body }) {
      const created = withEtag<{ id: string }>(ctx, await runTeam(ctx, "createTeam", params.organizationId, body));
      ctx.setHeader("Location", `/v1/organizations/${encodeURIComponent(params.organizationId)}/teams/${encodeURIComponent(created.id)}`);
      return created as never;
    },
  }),

  defineRoute({
    id: "teams.update",
    method: "PATCH",
    path: "/v1/organizations/:organizationId/teams/:teamId",
    summary: "Edit a team",
    description: `Send only what changes. \`null\` clears \`externalId\` or moves the team to the top level (\`parentId\`). Send \`If-Match\` with the team's version to refuse a stale edit.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamParams,
    body: s.object({
      name: s.optional(s.string({ min: 1, max: 255 })),
      slug: s.optional(s.string({ min: 1, max: 100 })),
      externalId: s.optional(s.nullable(s.string({ min: 1, max: 200 }))),
      parentId: s.optional(s.nullable(id("The new parent team."))),
      metadata: s.optional(FreeData),
      settings: s.optional(FreeData),
    }),
    response: TeamOut,
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_slug_taken", "team_external_id_taken", "team_parent_invalid", "team_cycle", "team_too_deep", "team_archived"],
    handler: async (ctx, { params, body }) => withEtag(ctx, await runTeam(ctx, "updateTeam", params.organizationId, { teamId: params.teamId, ...body, ...versioned(ctx) })),
  }),

  defineRoute({
    id: "teams.archive",
    method: "POST",
    path: "/v1/organizations/:organizationId/teams/:teamId/archive",
    summary: "Archive a team",
    description: `An archived team keeps its history and accepts no changes until restored. Refused while it still has active sub-teams: archive those first (\`team_has_children\`).${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamParams,
    body: s.object({ reason }),
    response: TeamOut,
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_has_children"],
    handler: async (ctx, { params, body }) => withEtag(ctx, await runTeam(ctx, "archiveTeam", params.organizationId, { teamId: params.teamId, ...body, ...versioned(ctx) })),
  }),

  defineRoute({
    id: "teams.restore",
    method: "POST",
    path: "/v1/organizations/:organizationId/teams/:teamId/restore",
    summary: "Restore an archived team",
    description: `Brings the team back to normal operation.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamParams,
    response: TeamOut,
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_not_archived"],
    handler: async (ctx, { params }) => withEtag(ctx, await runTeam(ctx, "restoreTeam", params.organizationId, { teamId: params.teamId, ...versioned(ctx) })),
  }),

  defineRoute({
    id: "teams.delete",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/teams/:teamId",
    summary: "Delete a team",
    description: `Only an archived team can be deleted, and only once it has no sub-teams. Archiving alone keeps the history.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamParams,
    response: s.object({ deleted: s.bool() }),
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_has_children", "team_not_archived"],
    handler: async (ctx, { params }) => (await runTeam(ctx, "deleteTeam", params.organizationId, { teamId: params.teamId })) as never,
  }),

  defineRoute({
    id: "teams.addMember",
    method: "POST",
    path: "/v1/organizations/:organizationId/teams/:teamId/members",
    summary: "Add a member to a team, or invite them",
    description: `Needs \`teams.members.add\`, even for oneself. With \`status: "pending"\` the person must accept. The roles given apply only inside this team, and only if the actor holds every permission in them.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    status: 201,
    params: teamParams,
    body: s.object({
      id: s.optional(id("Your own id for the team membership; generated when omitted.")),
      membershipId: id("The organization membership to add.", "mem_ana"),
      status: s.optional(s.enum(["pending", "active"] as const)),
      responsibility: s.optional(s.enum(TEAM_RESPONSIBILITIES)),
      roleIds: s.optional(s.array(roleParam, { max: 50 })),
    }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_membership_exists", "team_member_unknown", "team_archived", "team_role_invalid"],
    handler: async (ctx, { params, body }) => withEtag(ctx, await runTeam(ctx, "addMember", params.organizationId, { teamId: params.teamId, ...body })),
  }),

  defineRoute({
    id: "teams.leave",
    method: "POST",
    path: "/v1/organizations/:organizationId/teams/:teamId/leave",
    summary: "The actor leaves a team, or declines an invitation",
    description: `Always allowed for oneself.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamParams,
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_membership_not_found"],
    handler: async (ctx, { params }) => withEtag(ctx, await runTeam(ctx, "leaveTeam", params.organizationId, { teamId: params.teamId })),
  }),

  defineRoute({
    id: "teamMembers.accept",
    method: "POST",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId/accept",
    summary: "Accept a team invitation",
    description: `Only the invited person can accept their own invitation.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamMembershipParams,
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    handler: async (ctx, { params }) => withEtag(ctx, await runTeam(ctx, "acceptInvitation", params.organizationId, { teamMembershipId: params.teamMembershipId })),
  }),

  defineRoute({
    id: "teamMembers.remove",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId",
    summary: "Remove someone from a team",
    description: `The row stays for the record and can be added again. Needs \`teams.members.remove\`.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamMembershipParams,
    query: s.object({ reason }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    handler: async (ctx, { params, query }) => withEtag(ctx, await runTeam(ctx, "removeMember", params.organizationId, { teamMembershipId: params.teamMembershipId, ...query })),
  }),

  defineRoute({
    id: "teamMembers.suspend",
    method: "POST",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId/suspend",
    summary: "Suspend a team membership",
    description: `The relation exists but stops counting for now.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamMembershipParams,
    body: s.object({ reason }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    handler: async (ctx, { params, body }) => withEtag(ctx, await runTeam(ctx, "suspendMember", params.organizationId, { teamMembershipId: params.teamMembershipId, ...body })),
  }),

  defineRoute({
    id: "teamMembers.reactivate",
    method: "POST",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId/reactivate",
    summary: "Lift a team suspension",
    description: `Nobody lifts their own suspension.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamMembershipParams,
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    handler: async (ctx, { params }) => withEtag(ctx, await runTeam(ctx, "reactivateMember", params.organizationId, { teamMembershipId: params.teamMembershipId })),
  }),

  defineRoute({
    id: "teamMembers.setResponsibility",
    method: "PUT",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId/responsibility",
    summary: "Set who looks after a team",
    description: `A label (\`owner\`, \`manager\`, \`member\`), not a permission. Nobody changes their own.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: teamMembershipParams,
    body: s.object({ responsibility: s.enum(TEAM_RESPONSIBILITIES) }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    handler: async (ctx, { params, body }) => withEtag(ctx, await runTeam(ctx, "setResponsibility", params.organizationId, { teamMembershipId: params.teamMembershipId, ...body })),
  }),

  defineRoute({
    id: "teamMembers.assignRole",
    method: "PUT",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId/roles/:roleId",
    summary: "Give a team member a role inside the team",
    description: `Applies only inside this team. The actor must hold every permission of the role, and never changes their own.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: s.object({ organizationId: org, teamMembershipId: teamMembership, roleId: roleParam }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: [...MEMBER_ERRORS, "team_role_invalid", "team_role_owner_protected"],
    handler: async (ctx, { params }) => withEtag(ctx, await runTeam(ctx, "assignRole", params.organizationId, { teamMembershipId: params.teamMembershipId, roleId: params.roleId })),
  }),

  defineRoute({
    id: "teamMembers.unassignRole",
    method: "DELETE",
    path: "/v1/organizations/:organizationId/team-memberships/:teamMembershipId/roles/:roleId",
    summary: "Take a role away from a team member",
    description: `Inside the team only.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    params: s.object({ organizationId: org, teamMembershipId: teamMembership, roleId: roleParam }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: MEMBER_ERRORS,
    handler: async (ctx, { params }) => withEtag(ctx, await runTeam(ctx, "unassignRole", params.organizationId, { teamMembershipId: params.teamMembershipId, roleId: params.roleId })),
  }),

  defineRoute({
    id: "teamMembers.move",
    method: "POST",
    path: "/v1/organizations/:organizationId/team-moves",
    summary: "Move a member from one team to another",
    description: `Atomic: it needs \`teams.members.remove\` in the source team and \`teams.members.add\` in the destination.${DELEGATED_NOTE}`,
    scope: "teams:write",
    delegated: true,
    status: 201,
    params: orgParams,
    body: s.object({
      id: s.optional(id("Your own id for the new team membership; generated when omitted.")),
      membershipId: id("The organization membership that changes team.", "mem_ana"),
      fromTeamId: team,
      toTeamId: team,
      reason,
    }),
    response: TeamMembershipOut,
    organization: ({ params }) => params.organizationId,
    errors: [...TEAM_ERRORS, "team_membership_not_found", "team_membership_exists"],
    handler: async (ctx, { params, body }) => withEtag(ctx, await runTeam(ctx, "moveMember", params.organizationId, body)),
  }),
];
