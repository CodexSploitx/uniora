"use server";

import { createOrganizationWithOwner, OrganizationError, type UnioraStorage } from "@uniora/core";
import { audit, mutate, mutateInOrg, newId, text, type ActionResult } from "@/actions/mutate";

export interface CreateOrganizationArgs {
  name: string;
  slug?: string;
  ownerProvider: string;
  ownerSubject: string;
}

export async function createOrganization(args: CreateOrganizationArgs): Promise<ActionResult<{ id: string }>> {
  return mutate(["/", "/organizations"], async (tx) => {
    const organizationId = newId();
    const name = text(args?.name, "field.organizationName", { max: 255 });
    const slug = text(args?.slug, "field.slug", { max: 63, optional: true });
    const provider = text(args?.ownerProvider, "field.ownerProvider", { max: 64 });
    const subject = text(args?.ownerSubject, "field.ownerSubject", { max: 255 });

    // `createOrganizationWithOwner` opens its own transaction; reuse this one
    // so the organization, its Owner and the audit entry commit together.
    const nested = { ...tx, transaction: (callback) => callback(tx) } as UnioraStorage;
    const { organization } = await createOrganizationWithOwner(nested, {
      organizationId,
      organizationName: name,
      organizationSlug: slug,
      ownerRoleId: newId(),
      membershipId: newId(),
      ownerIdentity: { provider, subject },
    });
    await audit(tx, organization.id, "organization.created", { type: "organization", id: organization.id }, {
      name: organization.name,
      slug: organization.slug,
      owner: { provider, subject },
    });
    return { id: organization.id };
  });
}

export async function renameOrganization(args: { organizationId: string; name: string }): Promise<ActionResult> {
  return mutateInOrg(
    args?.organizationId,
    (organizationId) => ["/", "/organizations", `/organizations/${organizationId}`],
    async (tx, organizationId) => {
      const name = text(args?.name, "field.organizationName", { max: 255 });
      const previous = await tx.organizations.findById(organizationId);
      const updated = await tx.organizations.rename(organizationId, name);
      if (!previous || !updated) throw new OrganizationError("Organization not found.");
      await audit(tx, organizationId, "organization.renamed", { type: "organization", id: organizationId }, {
        from: previous.name,
        to: updated.name,
      });
    },
  );
}
