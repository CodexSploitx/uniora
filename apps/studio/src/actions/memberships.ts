"use server";

import type { UnioraTransaction } from "@uniora/core";
import { StudioError } from "@/lib/validate";
import { audit, mutateInOrg, newId, studioActor, text, type ActionResult } from "@/actions/mutate";

const orgPaths = (organizationId: string) => [`/organizations/${organizationId}`, "/organizations", "/"];

// Single-row lookups (never "load every member/role of the organization
// and scan"): the membership must exist AND belong to this organization, the
// role is fetched as a light summary (no permission list).
async function requireMember(tx: UnioraTransaction, organizationId: string, membershipId: string) {
  const member = await tx.memberships.findById(membershipId);
  if (!member || member.organizationId !== organizationId) throw new StudioError("errors.memberGone");
  return member;
}

async function requireOrgRole(tx: UnioraTransaction, organizationId: string, roleId: string) {
  const [role] = await tx.roles.findSummariesByIds([roleId]);
  if (!role || role.organizationId !== organizationId) throw new StudioError("errors.roleOtherOrg");
  return role;
}

export async function addMember(args: {
  organizationId: string;
  provider: string;
  subject: string;
  roleId?: string;
}): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const identity = {
      provider: text(args.provider, "field.provider", { max: 64 }),
      subject: text(args.subject, "field.subject", { max: 255 }),
    };
    if (await tx.memberships.findByIdentity(organizationId, identity)) {
      throw new StudioError("errors.identityExists");
    }
    const roleId = text(args.roleId, "field.role", { max: 128, optional: true });
    const role = roleId ? await requireOrgRole(tx, organizationId, roleId) : undefined;

    const membership = await tx.memberships.create({
      id: newId(),
      organizationId,
      identity,
      roleIds: role ? [role.id] : [],
    });
    await audit(tx, organizationId, "membership.created", { type: "membership", id: membership.id }, {
      identity,
      role: role?.name ?? null,
    });
  });
}

export async function assignMemberRole(args: {
  organizationId: string;
  membershipId: string;
  roleId: string;
}): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const member = await requireMember(tx, organizationId, text(args.membershipId, "field.member", { max: 128 }));
    const role = await requireOrgRole(tx, organizationId, text(args.roleId, "field.role", { max: 128 }));
    // `assignRole`/`assignOwnerRole` are deliberately separate methods
    // (docs/security-pentest-2026-09-24.md Hallazgo 7) — Studio's own
    // session is already fully privileged either way, but it still has to
    // call the right one, since the generic method now rejects the Owner
    // role outright.
    if (role.isOwnerRole) {
      await tx.memberships.assignOwnerRole(member.id, role.id);
    } else {
      await tx.memberships.assignRole(member.id, role.id);
    }
    await audit(tx, organizationId, "membership.role_assigned", { type: "membership", id: member.id }, {
      identity: member.identity,
      role: role.name,
    });
  });
}

export async function unassignMemberRole(args: {
  organizationId: string;
  membershipId: string;
  roleId: string;
}): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const member = await requireMember(tx, organizationId, text(args.membershipId, "field.member", { max: 128 }));
    const role = await requireOrgRole(tx, organizationId, text(args.roleId, "field.role", { max: 128 }));
    // Same split as assignMemberRole above.
    if (role.isOwnerRole) {
      await tx.memberships.unassignOwnerRole(member.id, role.id);
    } else {
      await tx.memberships.unassignRole(member.id, role.id);
    }
    await audit(tx, organizationId, "membership.role_unassigned", { type: "membership", id: member.id }, {
      identity: member.identity,
      role: role.name,
    });
  });
}

export async function removeMember(args: { organizationId: string; membershipId: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const member = await requireMember(tx, organizationId, text(args.membershipId, "field.member", { max: 128 }));
    await tx.memberships.delete(member.id);
    await audit(tx, organizationId, "membership.deleted", { type: "membership", id: member.id }, {
      identity: member.identity,
    });
  });
}

export async function setMemberStatus(args: {
  organizationId: string;
  membershipId: string;
  action: "block" | "suspend" | "unblock";
  reason?: string;
  /** ISO date for `suspend`. */
  until?: string;
}): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const member = await requireMember(tx, organizationId, text(args.membershipId, "field.member", { max: 128 }));
    const actor = studioActor();
    const reason = text(args.reason, "field.reason", { max: 500, optional: true });
    if (args.action === "unblock") {
      await tx.memberships.unblock(member.id, { actor });
    } else if (args.action === "block") {
      await tx.memberships.block(member.id, { actor, reason });
    } else if (args.action === "suspend") {
      const until = new Date(text(args.until, "field.until", { max: 40 }));
      if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) throw new StudioError("errors.untilInvalid");
      await tx.memberships.suspend(member.id, { actor, reason, until });
    } else {
      throw new StudioError("errors.unexpected");
    }
  });
}
