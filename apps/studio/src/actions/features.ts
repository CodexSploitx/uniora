"use server";

import { StudioError } from "@/lib/validate";
import { audit, mutateInOrg, mutate, text, type ActionResult } from "@/actions/mutate";

export async function setOrganizationFeature(args: {
  organizationId: string;
  key: string;
  enabled: boolean;
}): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, (id) => [`/organizations/${id}`, "/features", "/organizations", "/"], async (tx, organizationId) => {
    if (!(await tx.organizations.findById(organizationId))) throw new StudioError("errors.orgGone");
    const key = text(args.key, "field.feature", { max: 128 });
    if (args.enabled === true) {
      await tx.features.enable(organizationId, key);
    } else {
      await tx.features.disable(organizationId, key);
    }
    await audit(tx, organizationId, args.enabled === true ? "feature.enabled" : "feature.disabled", {
      type: "feature",
      id: key,
    });
  });
}

export async function registerFeature(args: { name: string; key?: string; description?: string }): Promise<ActionResult> {
  return mutate(["/features"], async (tx) => {
    await tx.features.register({
      name: text(args?.name, "field.featureName", { max: 100 }),
      key: text(args?.key, "field.featureKey", { max: 64, optional: true }),
      description: text(args?.description, "field.description", { max: 500, optional: true }),
    });
  });
}

export async function unregisterFeature(args: { key: string }): Promise<ActionResult> {
  return mutate(["/features"], async (tx) => {
    await tx.features.unregister(text(args?.key, "field.feature", { max: 128 }));
  });
}
