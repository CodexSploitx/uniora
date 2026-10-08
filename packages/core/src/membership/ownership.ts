import type { Identity } from "../identity/types.js";
import type { UnioraStorage } from "../storage/types.js";
import { MembershipError } from "./repository.js";
import { randomId } from "../invitation/token.js";

export interface TransferOwnershipInput {
  organizationId: string;
  /** The membership giving up the Owner role. It must currently hold it. */
  fromMembershipId: string;
  /** The membership that becomes Owner. It must belong to the same organization. */
  toMembershipId: string;
  /** Who performs the transfer; recorded in the audit log. The host must have authorized it. */
  actor: Identity;
  /** Keep the previous owner as a second Owner instead of removing the role. Default `false`. */
  keepPreviousOwner?: boolean;
  generateId?: () => string;
}

/**
 * Hands the organization's Owner role from one member to another, atomically: either the new owner
 * has it (and the old one doesn't, unless `keepPreviousOwner`) or nothing changed. The organization
 * can never be observed without an owner, and both memberships are checked against `organizationId`.
 *
 * The member receiving ownership must be active (`membership_blocked` otherwise).
 *
 * **No authorization of its own.** Guard it with a permission stricter than ordinary role changes
 * (e.g. `organization.transfer_ownership`), the same trust boundary as `assignOwnerRole`.
 */
export async function transferOwnership(storage: UnioraStorage, input: TransferOwnershipInput): Promise<void> {
  if (input.fromMembershipId === input.toMembershipId) {
    throw new MembershipError("The new owner must be a different member.");
  }
  const generateId = input.generateId ?? randomId;
  await storage.transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.memberships.findById(input.fromMembershipId),
      tx.memberships.findById(input.toMembershipId),
    ]);
    if (!from || from.organizationId !== input.organizationId || !to || to.organizationId !== input.organizationId) {
      throw new MembershipError("Both members must belong to this organization.");
    }
    const ownerRole = (await tx.roles.listByOrganization(input.organizationId)).find((role) => role.isOwnerRole);
    if (!ownerRole) throw new MembershipError("This organization has no Owner role.");
    // Handing the Owner role to someone who is blocked or suspended could leave the organization with nobody who can act.
    if (to.status !== "active") {
      throw new MembershipError("The member receiving ownership is blocked or suspended.", "membership_blocked");
    }
    if (!from.roleIds.includes(ownerRole.id)) {
      throw new MembershipError("The member handing over ownership is not an Owner.");
    }

    // Grant first, remove second: at no point is the organization without an Owner.
    await tx.memberships.assignOwnerRole(to.id, ownerRole.id);
    if (!input.keepPreviousOwner) await tx.memberships.unassignOwnerRole(from.id, ownerRole.id);

    await tx.auditLogs.record({
      id: generateId(),
      organizationId: input.organizationId,
      actor: input.actor,
      action: "organization.ownership_transferred",
      target: { type: "membership", id: to.id },
      metadata: { fromMembershipId: from.id, toMembershipId: to.id, keepPreviousOwner: input.keepPreviousOwner === true },
    });
  });
}

export interface LeaveOrganizationInput {
  organizationId: string;
  /** The identity leaving. It can only remove its own membership. */
  identity: Identity;
  generateId?: () => string;
}

/**
 * The caller removes THEIR OWN membership. A blocked or suspended member can't leave (`membership_blocked`; an administrator removes them with `delete`). The last Owner can't leave (transfer ownership first):
 * `MembershipRepository.delete` refuses it, and so does this. Returns `false` when the identity
 * wasn't a member (nothing to do).
 */
export async function leaveOrganization(storage: UnioraStorage, input: LeaveOrganizationInput): Promise<boolean> {
  const generateId = input.generateId ?? randomId;
  return storage.transaction(async (tx) => {
    const membership = await tx.memberships.findByIdentity(input.organizationId, input.identity);
    if (!membership) return false;
    // A sanctioned member can't shed the sanction by leaving (and coming back through an invitation they still hold).
    if (membership.status !== "active") {
      throw new MembershipError("A blocked or suspended member can't leave the organization.", "membership_blocked");
    }
    await tx.memberships.delete(membership.id);
    await tx.auditLogs.record({
      id: generateId(),
      organizationId: input.organizationId,
      actor: input.identity,
      action: "membership.left",
      target: { type: "membership", id: membership.id },
      metadata: {},
    });
    return true;
  });
}
