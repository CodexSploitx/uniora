import type { Identity } from "../identity/types.js";
import { sameIdentity } from "../identity/types.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import type { AuthorizationEngine, AuthorizationEngineOptions } from "../authorization/engine.js";
import { createAuditedStorage } from "../storage/audited.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";
import type { Membership } from "../membership/types.js";
import type { Role } from "../role/types.js";
import { TeamError } from "./repository.js";
import { issueTeamAuthorization } from "./authorization.js";
import type { TeamOperation } from "./authorization.js";
import type { AddTeamMemberInput, CreateTeamInput, UpdateTeamInput } from "./repository.js";
import type { Team, TeamMembership, TeamResponsibility } from "./types.js";

/**
 * The permission keys the team service asks the authorization engine about. Register them in your catalog and give them to
 * the roles that should manage teams; override any of them with `createTeamService({ permissions })`.
 */
export const TEAM_PERMISSIONS = {
  /** Create, edit, archive, restore and delete teams; promote a member to team owner. */
  manage: "teams.manage",
  /** Add or invite people to a team (this is also what "joining another team" needs). */
  membersAdd: "teams.members.add",
  /** Remove someone else from a team. */
  membersRemove: "teams.members.remove",
  /** Suspend, reactivate, change the responsibility or the roles of a team member. */
  membersManage: "teams.members.manage",
} as const;

export type TeamPermissionKeys = { [K in keyof typeof TEAM_PERMISSIONS]: string };

export interface TeamServiceOptions {
  storage: UnioraStorage;
  /** Passed to the engine the service builds (for example `ownerRequiresRegisteredPermission` or `onDecision`). */
  engine?: AuthorizationEngineOptions;
  /** Replace any of the default permission keys. */
  permissions?: Partial<TeamPermissionKeys>;
}

/** Everything the service does on someone's behalf names that someone. It is the identity the engine is asked about. */
export interface TeamActor {
  actor: Identity;
}

export interface MoveTeamMemberInput extends TeamActor {
  organizationId: string;
  /** The organization membership that changes team. */
  membershipId: string;
  fromTeamId: string;
  toTeamId: string;
  /** Id for the membership in the destination team. */
  id: string;
  reason?: string;
}

/**
 * The ONLY sanctioned way to change who belongs to which team. Every operation asks the authorization engine first,
 * inside the same transaction as the change, and writes the audit entries with the actor, so nothing here depends on the
 * caller remembering to check:
 *
 * - Joining or being added to a team needs `teams.members.add`, even when the person adds themselves.
 * - Leaving a team (or declining an invitation) is always allowed for yourself; removing someone else needs `teams.members.remove`.
 * - Changing teams (`moveMember`) needs both `teams.members.remove` in the source team and `teams.members.add` in the destination.
 * - Nobody changes their own responsibility or roles, or lifts their own suspension (no self-promotion).
 * - You can only give a role whose every permission you hold yourself in that team (no escalation through team roles).
 * - Each permission is satisfied organization-wide (a role of the organization) or inside that very team (a role held there);
 *   being a team owner or manager grants nothing by itself.
 *
 * It uses the plain repositories underneath, which authorize nothing: do not hand `storage.teamMemberships` to code that
 * serves end users.
 */
export interface TeamService {
  createTeam(input: Omit<CreateTeamInput, "authorization"> & TeamActor): Promise<Team>;
  updateTeam(input: { organizationId: string; teamId: string } & TeamActor & Omit<UpdateTeamInput, "authorization">): Promise<Team>;
  archiveTeam(input: { organizationId: string; teamId: string; reason?: string; expectedVersion?: number } & TeamActor): Promise<Team>;
  restoreTeam(input: { organizationId: string; teamId: string; expectedVersion?: number } & TeamActor): Promise<Team>;
  deleteTeam(input: { organizationId: string; teamId: string } & TeamActor): Promise<void>;

  /** Adds (or, with `status: "pending"`, invites) an organization member to a team. */
  addMember(input: Omit<AddTeamMemberInput, "authorization"> & TeamActor): Promise<TeamMembership>;
  /** The invited person accepts their own invitation. */
  acceptInvitation(input: { organizationId: string; teamMembershipId: string } & TeamActor): Promise<TeamMembership>;
  /** The actor leaves a team, or declines an invitation. */
  leaveTeam(input: { organizationId: string; teamId: string } & TeamActor): Promise<TeamMembership>;
  removeMember(input: { organizationId: string; teamMembershipId: string; reason?: string } & TeamActor): Promise<TeamMembership>;
  suspendMember(input: { organizationId: string; teamMembershipId: string; reason?: string } & TeamActor): Promise<TeamMembership>;
  reactivateMember(input: { organizationId: string; teamMembershipId: string } & TeamActor): Promise<TeamMembership>;
  setResponsibility(input: { organizationId: string; teamMembershipId: string; responsibility: TeamResponsibility } & TeamActor): Promise<TeamMembership>;
  assignRole(input: { organizationId: string; teamMembershipId: string; roleId: string } & TeamActor): Promise<TeamMembership>;
  unassignRole(input: { organizationId: string; teamMembershipId: string; roleId: string } & TeamActor): Promise<TeamMembership>;
  /** Takes someone out of one team and puts them in another, atomically, with both permissions required. */
  moveMember(input: MoveTeamMemberInput): Promise<TeamMembership>;
}

const forbidden = (what: string) => new TeamError(`You are not allowed to ${what}.`, "team_forbidden");

export function createTeamService(options: TeamServiceOptions): TeamService {
  const keys: TeamPermissionKeys = { ...TEAM_PERMISSIONS, ...options.permissions };

  /** Runs `work` in one transaction with an engine bound to that same transaction and an audited view that records the actor. */
  function run<T>(actor: Identity, work: (ctx: Context) => Promise<T>): Promise<T> {
    const audited = createAuditedStorage(options.storage, { actor });
    return audited.transaction(async (tx) => {
      // The engine reads through the transaction, so what it decides and what is written see the same data.
      const engine = createAuthorizationEngine({ ...tx, transaction: options.storage.transaction.bind(options.storage) } as UnioraStorage, options.engine);
      return work({ tx, engine, actor });
    });
  }

  interface Context {
    tx: UnioraTransaction;
    engine: AuthorizationEngine;
    actor: Identity;
  }

  /** Whole-organization grant, or a grant inside that very team. Never anything else. */
  async function allowed(ctx: Context, organizationId: string, permission: string, teamId?: string): Promise<boolean> {
    if (await ctx.engine.can({ identity: ctx.actor, organizationId, permission })) return true;
    return teamId !== undefined && (await ctx.engine.can({ identity: ctx.actor, organizationId, permission, teamId }));
  }

  async function require(ctx: Context, organizationId: string, permission: string, what: string, teamId?: string): Promise<void> {
    if (!(await allowed(ctx, organizationId, permission, teamId))) throw forbidden(what);
  }

  /** Proof for the repositories, issued only AFTER the checks above it passed. Bound to this organization, actor and operation. */
  const grant = (ctx: Context, organizationId: string, ...operations: TeamOperation[]) =>
    issueTeamAuthorization(organizationId, ctx.actor, operations);

  const actorMembership = (ctx: Context, organizationId: string): Promise<Membership | null> =>
    ctx.tx.memberships.findByIdentity(organizationId, ctx.actor);

  async function loadRow(ctx: Context, organizationId: string, id: string): Promise<TeamMembership> {
    const row = await ctx.tx.teamMemberships.findById(organizationId, id);
    // A row of another organization is the same as a missing one: the actor learns nothing about it.
    if (!row) throw new TeamError(`Team membership not found: ${id}`, "team_membership_not_found");
    return row;
  }

  /** Whether the row is the actor's own (the actor's identity, or the one it resolves to, owns the organization membership). */
  async function isOwnRow(ctx: Context, row: TeamMembership): Promise<boolean> {
    const mine = await actorMembership(ctx, row.organizationId);
    return mine !== null && mine.id === row.membershipId;
  }

  /** The actor may only hand out roles whose every permission they hold themselves, in that team or organization-wide. */
  async function assertCanGrant(ctx: Context, organizationId: string, teamId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const roles: Role[] = await ctx.tx.roles.findByIds(roleIds);
    for (const role of roles) {
      if (role.organizationId !== organizationId) throw new TeamError("Every role of a team member must exist in the same organization.", "team_role_invalid");
      if (role.isOwnerRole) throw new TeamError("The Owner role cannot be held inside a team.", "team_role_owner_protected");
      for (const permission of role.permissionKeys) {
        if (!(await allowed(ctx, organizationId, permission, teamId))) {
          throw new TeamError("You cannot give a role that holds permissions you do not hold yourself.", "team_forbidden");
        }
      }
    }
  }

  return {
    createTeam: ({ actor, ...input }) =>
      run(actor, async (ctx) => {
        await require(ctx, input.organizationId, keys.manage, "create teams");
        return ctx.tx.teams.create({ ...input, authorization: grant(ctx, input.organizationId, "team.create") });
      }),

    updateTeam: ({ actor, organizationId, teamId, ...change }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.manage, "change this team", teamId);
        return ctx.tx.teams.update(organizationId, teamId, { ...change, authorization: grant(ctx, organizationId, "team.update") });
      }),

    archiveTeam: ({ actor, organizationId, teamId, ...rest }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.manage, "archive this team", teamId);
        return ctx.tx.teams.archive(organizationId, teamId, { ...rest, actor, authorization: grant(ctx, organizationId, "team.archive") });
      }),

    restoreTeam: ({ actor, organizationId, teamId, ...rest }) =>
      run(actor, async (ctx) => {
        await require(ctx, organizationId, keys.manage, "restore this team", teamId);
        return ctx.tx.teams.restore(organizationId, teamId, { ...rest, actor, authorization: grant(ctx, organizationId, "team.restore") });
      }),

    deleteTeam: ({ actor, organizationId, teamId }) =>
      run(actor, async (ctx) => {
        // Deleting is irreversible: only an organization-wide grant, not one held inside the team being deleted.
        await require(ctx, organizationId, keys.manage, "delete this team");
        await ctx.tx.teams.delete(organizationId, teamId, { authorization: grant(ctx, organizationId, "team.delete") });
      }),

    addMember: ({ actor, ...input }) =>
      run(actor, async (ctx) => {
        await require(ctx, input.organizationId, keys.membersAdd, "add people to this team", input.teamId);
        if ((input.responsibility ?? "member") === "owner") {
          await require(ctx, input.organizationId, keys.manage, "make someone owner of this team", input.teamId);
        }
        await assertCanGrant(ctx, input.organizationId, input.teamId, input.roleIds ?? []);
        // The inviter is whoever is acting, never a name the caller supplies.
        return ctx.tx.teamMemberships.add({ ...input, invitedBy: actor, authorization: grant(ctx, input.organizationId, "member.add") });
      }),

    acceptInvitation: ({ actor, organizationId, teamMembershipId }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        return ctx.tx.teamMemberships.accept(organizationId, row.id, { actor, authorization: grant(ctx, organizationId, "member.accept") });
      }),

    leaveTeam: ({ actor, organizationId, teamId }) =>
      run(actor, async (ctx) => {
        const mine = await actorMembership(ctx, organizationId);
        const row = mine ? await ctx.tx.teamMemberships.find(organizationId, teamId, mine.id) : null;
        if (!row) throw new TeamError("You do not belong to this team.", "team_membership_not_found");
        return ctx.tx.teamMemberships.setStatus(organizationId, row.id, "removed", { actor, reason: "left", authorization: grant(ctx, organizationId, "member.status") });
      }),

    removeMember: ({ actor, organizationId, teamMembershipId, reason }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        if (!(await isOwnRow(ctx, row))) await require(ctx, organizationId, keys.membersRemove, "remove people from this team", row.teamId);
        return ctx.tx.teamMemberships.setStatus(organizationId, row.id, "removed", { actor, reason, authorization: grant(ctx, organizationId, "member.status") });
      }),

    suspendMember: ({ actor, organizationId, teamMembershipId, reason }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        await require(ctx, organizationId, keys.membersManage, "suspend people in this team", row.teamId);
        return ctx.tx.teamMemberships.setStatus(organizationId, row.id, "suspended", { actor, reason, authorization: grant(ctx, organizationId, "member.status") });
      }),

    reactivateMember: ({ actor, organizationId, teamMembershipId }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        if (await isOwnRow(ctx, row)) throw forbidden("lift your own suspension");
        await require(ctx, organizationId, keys.membersManage, "reactivate people in this team", row.teamId);
        return ctx.tx.teamMemberships.setStatus(organizationId, row.id, "active", { actor, authorization: grant(ctx, organizationId, "member.status") });
      }),

    setResponsibility: ({ actor, organizationId, teamMembershipId, responsibility }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        if (await isOwnRow(ctx, row)) throw forbidden("change your own responsibility");
        await require(ctx, organizationId, keys.membersManage, "change responsibilities in this team", row.teamId);
        if (responsibility === "owner" || row.responsibility === "owner") {
          await require(ctx, organizationId, keys.manage, "change the owner of this team", row.teamId);
        }
        return ctx.tx.teamMemberships.setResponsibility(organizationId, row.id, responsibility, { authorization: grant(ctx, organizationId, "member.responsibility") });
      }),

    assignRole: ({ actor, organizationId, teamMembershipId, roleId }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        if (await isOwnRow(ctx, row)) throw forbidden("give yourself roles");
        await require(ctx, organizationId, keys.membersManage, "give roles in this team", row.teamId);
        await assertCanGrant(ctx, organizationId, row.teamId, [roleId]);
        return ctx.tx.teamMemberships.assignRole(organizationId, row.id, roleId, { authorization: grant(ctx, organizationId, "member.role") });
      }),

    unassignRole: ({ actor, organizationId, teamMembershipId, roleId }) =>
      run(actor, async (ctx) => {
        const row = await loadRow(ctx, organizationId, teamMembershipId);
        await require(ctx, organizationId, keys.membersManage, "take roles away in this team", row.teamId);
        return ctx.tx.teamMemberships.unassignRole(organizationId, row.id, roleId, { authorization: grant(ctx, organizationId, "member.role") });
      }),

    moveMember: ({ actor, organizationId, membershipId, fromTeamId, toTeamId, id, reason }) =>
      run(actor, async (ctx) => {
        if (fromTeamId === toTeamId) throw new TeamError("The source and the destination team are the same.", "team_membership_invalid");
        // Both halves are checked before anything changes, and both run in this one transaction.
        await require(ctx, organizationId, keys.membersRemove, "take people out of the source team", fromTeamId);
        await require(ctx, organizationId, keys.membersAdd, "add people to the destination team", toTeamId);
        const from = await ctx.tx.teamMemberships.find(organizationId, fromTeamId, membershipId);
        if (!from || from.status === "removed") throw new TeamError("The member does not belong to the source team.", "team_membership_not_found");
        const target = await ctx.tx.memberships.findById(membershipId);
        if (!target || target.organizationId !== organizationId) throw new TeamError("Membership does not exist in this organization.", "team_member_unknown");
        if (sameIdentity(target.identity, actor)) throw forbidden("move yourself; ask someone with permission");
        // Add first: if the destination refuses (archived, already a member...), nothing has changed yet.
        const joined = await ctx.tx.teamMemberships.add({ id, organizationId, teamId: toTeamId, membershipId, invitedBy: actor, authorization: grant(ctx, organizationId, "member.add") });
        await ctx.tx.teamMemberships.setStatus(organizationId, from.id, "removed", { actor, reason: reason ?? "moved", authorization: grant(ctx, organizationId, "member.status") });
        return joined;
      }),
  };
}
