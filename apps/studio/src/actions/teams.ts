"use server";

import { createTrustedTeamStorage, type UnioraStorage, type UnioraTransaction } from "@uniora/core";
import { StudioError } from "@/lib/validate";
import { audit, mutateInOrg, newId, studioActor, text, type ActionResult } from "@/actions/mutate";

const orgPaths = (organizationId: string) => [`/organizations/${organizationId}`];

/**
 * Studio is a back-office tool: its session is the operator's authority (`requireWrite` already ran), so team changes
 * go through the trusted team storage, stamped with the operator and a reason, inside the action's own transaction.
 * Nothing here serves end users.
 */
function operatorTeams(tx: UnioraTransaction) {
  const shim = { ...tx, transaction: <T>(callback: (inner: UnioraTransaction) => Promise<T>) => callback(tx) } as unknown as UnioraStorage;
  return createTrustedTeamStorage(shim, { actor: studioActor(), reason: "Studio operator" });
}

const RESPONSIBILITIES = ["owner", "manager", "member"] as const;

export async function createTeam(args: { organizationId: string; name: string; parentId?: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const parentId = text(args.parentId, "field.parentTeam", { max: 200, optional: true });
    const team = await operatorTeams(tx).teams.create({
      id: newId(),
      organizationId,
      name: text(args.name, "field.teamName", { max: 255 }),
      ...(parentId !== undefined ? { parentId } : {}),
    });
    await audit(tx, organizationId, "team.created", { type: "team", id: team.id }, {
      name: team.name,
      slug: team.slug,
      ...(team.parentId !== undefined ? { parentId: team.parentId } : {}),
    });
  });
}

export async function archiveTeam(args: { organizationId: string; teamId: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const teamId = text(args.teamId, "field.team", { max: 200 });
    const team = await operatorTeams(tx).teams.archive(organizationId, teamId, { actor: studioActor() });
    await audit(tx, organizationId, "team.archived", { type: "team", id: team.id }, { requestedBy: "studio" });
  });
}

export async function restoreTeam(args: { organizationId: string; teamId: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const teamId = text(args.teamId, "field.team", { max: 200 });
    const team = await operatorTeams(tx).teams.restore(organizationId, teamId, { actor: studioActor() });
    await audit(tx, organizationId, "team.restored", { type: "team", id: team.id }, { requestedBy: "studio" });
  });
}

export async function deleteTeam(args: { organizationId: string; teamId: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const teamId = text(args.teamId, "field.team", { max: 200 });
    const before = await tx.teams.findById(organizationId, teamId);
    await operatorTeams(tx).teams.delete(organizationId, teamId);
    await audit(tx, organizationId, "team.deleted", { type: "team", id: teamId }, before ? { name: before.name, slug: before.slug } : undefined);
  });
}

export async function addTeamMember(args: { organizationId: string; teamId: string; provider: string; subject: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const teamId = text(args.teamId, "field.team", { max: 200 });
    const identity = {
      provider: text(args.provider, "field.provider", { max: 64 }),
      subject: text(args.subject, "field.subject", { max: 255 }),
    };
    const membership = await tx.memberships.findByIdentity(organizationId, identity);
    if (!membership) throw new StudioError("errors.memberGone");
    const row = await operatorTeams(tx).teamMemberships.add({
      id: newId(),
      organizationId,
      teamId,
      membershipId: membership.id,
      invitedBy: studioActor(),
    });
    await audit(tx, organizationId, "team_member.added", { type: "team_member", id: row.id }, { teamId, membershipId: membership.id, identity });
  });
}

type MemberChange = { status: "removed" | "suspended" | "active"; action: string };
const CHANGES: Record<"remove" | "suspend" | "reactivate", MemberChange> = {
  remove: { status: "removed", action: "team_member.removed" },
  suspend: { status: "suspended", action: "team_member.suspended" },
  reactivate: { status: "active", action: "team_member.reactivated" },
};

export async function changeTeamMember(args: { organizationId: string; teamMembershipId: string; change: "remove" | "suspend" | "reactivate" }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const teamMembershipId = text(args.teamMembershipId, "field.teamMember", { max: 200 });
    const change = CHANGES[args.change];
    if (!change) throw new StudioError("errors.unexpected");
    const row = await operatorTeams(tx).teamMemberships.setStatus(organizationId, teamMembershipId, change.status, { actor: studioActor() });
    await audit(tx, organizationId, change.action, { type: "team_member", id: row.id }, { teamId: row.teamId, membershipId: row.membershipId });
  });
}

export async function setTeamResponsibility(args: { organizationId: string; teamMembershipId: string; responsibility: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const teamMembershipId = text(args.teamMembershipId, "field.teamMember", { max: 200 });
    const responsibility = RESPONSIBILITIES.find((candidate) => candidate === args.responsibility);
    if (!responsibility) throw new StudioError("errors.unexpected");
    const before = await tx.teamMemberships.findById(organizationId, teamMembershipId);
    const row = await operatorTeams(tx).teamMemberships.setResponsibility(organizationId, teamMembershipId, responsibility);
    if (before && before.responsibility !== row.responsibility) {
      const ownerInvolved = before.responsibility === "owner" || row.responsibility === "owner";
      await audit(tx, organizationId, ownerInvolved ? "team.owner_changed" : "team.manager_changed", { type: "team_member", id: row.id }, {
        teamId: row.teamId,
        membershipId: row.membershipId,
        from: before.responsibility,
        to: row.responsibility,
      });
    }
  });
}
