import type { Identity } from "../identity/types.js";
import type { Membership } from "../membership/types.js";
import type { Role } from "../role/types.js";
import type { UnioraStorage } from "../storage/types.js";
import type { Organization } from "./types.js";

export interface CreateOrganizationWithOwnerInput {
  organizationId: string;
  organizationName: string;
  /** Optional — derived from `organizationName` when omitted, see `resolveOrganizationSlug`. */
  organizationSlug?: string;
  ownerRoleId: string;
  membershipId: string;
  ownerIdentity: Identity;
}

export interface CreateOrganizationWithOwnerResult {
  organization: Organization;
  ownerRole: Role;
  membership: Membership;
}

/**
 * Creates an organization together with its protected Owner role and the
 * founding membership, atomically. Every organization must be born with
 * exactly one owner — there is no other supported path to mint an
 * `isOwnerRole` role than `RoleRepository.createOwnerRole`, called here
 * inside a single `storage.transaction`, so a caller can never observe an
 * organization that exists without an owner (uniora-security-engineering
 * §11 Owner Protection, §21-22 Race Conditions/Transaction Boundaries).
 */
export async function createOrganizationWithOwner(
  storage: UnioraStorage,
  input: CreateOrganizationWithOwnerInput,
): Promise<CreateOrganizationWithOwnerResult> {
  return storage.transaction(async (tx) => {
    const organization = await tx.organizations.create({
      id: input.organizationId,
      name: input.organizationName,
      slug: input.organizationSlug,
    });
    const ownerRole = await tx.roles.createOwnerRole({ id: input.ownerRoleId, organizationId: organization.id });
    const membership = await tx.memberships.create({
      id: input.membershipId,
      organizationId: organization.id,
      identity: input.ownerIdentity,
      roleIds: [ownerRole.id],
    });
    return { organization, ownerRole, membership };
  });
}
