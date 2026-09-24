import {
  createAuthorizationEngine,
  createMemoryStorage,
  createOrganizationWithOwner,
  type AuthorizationEngine,
  type AuthorizationSnapshot,
  type FeatureRepository,
  type Identity,
} from "@uniora/core";
import { createCachedAuthorizationSnapshot } from "@uniora/next";

// This file is the only place in the playground that touches @uniora/core
// storage directly — it stands in for a real host app's database layer.
// Everything downstream (the page, the client components) only ever sees
// the resulting AuthorizationSnapshot, exactly like a real integration.

export type DemoRoleKey = "owner" | "sales" | "viewer";

export const DEMO_ROLES: readonly DemoRoleKey[] = ["owner", "sales", "viewer"];

export function isDemoRole(value: string | undefined): value is DemoRoleKey {
  return value === "owner" || value === "sales" || value === "viewer";
}

const DEMO_IDENTITIES: Record<DemoRoleKey, Identity> = {
  owner: { provider: "demo", subject: "ada-owner" },
  sales: { provider: "demo", subject: "sam-sales" },
  viewer: { provider: "demo", subject: "vic-viewer" },
};

export const DEMO_PERMISSIONS = ["vehicles.create", "vehicles.delete", "leads.create"] as const;
export const DEMO_FEATURES = ["advanced_reports", "ai_assistant"] as const;

/**
 * Seeds a fresh in-memory organization on every call — cheap for a demo,
 * and it keeps this file honest about being throwaway sample data, never
 * a real store (`createMemoryStorage` itself is documented in
 * `@uniora/core` as tests/prototyping only, never production).
 */
async function seedDemoOrganization() {
  const storage = createMemoryStorage();

  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: "org-acme-motors",
    organizationName: "Acme Motors",
    ownerRoleId: "role-owner",
    membershipId: "m-owner",
    ownerIdentity: DEMO_IDENTITIES.owner,
  });

  for (const key of DEMO_PERMISSIONS) {
    await storage.permissions.register({ key });
  }

  const salesRole = await storage.roles.create({
    id: "role-sales",
    organizationId: organization.id,
    name: "Sales",
    permissionKeys: ["leads.create"],
  });
  const salesMembership = await storage.memberships.create({
    id: "m-sales",
    organizationId: organization.id,
    identity: DEMO_IDENTITIES.sales,
  });
  await storage.memberships.assignRole(salesMembership.id, salesRole.id);

  const viewerRole = await storage.roles.create({
    id: "role-viewer",
    organizationId: organization.id,
    name: "Viewer",
  });
  const viewerMembership = await storage.memberships.create({
    id: "m-viewer",
    organizationId: organization.id,
    identity: DEMO_IDENTITIES.viewer,
  });
  await storage.memberships.assignRole(viewerMembership.id, viewerRole.id);

  await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
  await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
  await storage.features.enable(organization.id, "advanced_reports");
  // ai_assistant is left disabled on purpose, to demo a denied feature.

  return { storage, organization };
}

export interface DemoAuthorizationContext {
  engine: AuthorizationEngine;
  features: Pick<FeatureRepository, "isEnabled">;
  identity: Identity;
  organizationId: string;
}

/**
 * Resolves the real `AuthorizationEngine` + identity for a demo role —
 * used both by `computeDemoSnapshot` (read path, for `UnioraProvider`) and
 * by Server Actions/Route Handlers that need to independently re-authorize
 * a mutation server-side (defense in depth, never trusting that a hidden
 * `<Can>` button was enough — uniora-security-engineering INV-010).
 */
export async function getDemoAuthorization(role: DemoRoleKey): Promise<DemoAuthorizationContext> {
  const { storage, organization } = await seedDemoOrganization();
  return {
    engine: createAuthorizationEngine(storage),
    features: storage.features,
    identity: DEMO_IDENTITIES[role],
    organizationId: organization.id,
  };
}

/**
 * The only function a page ever calls — mirrors exactly how a real host
 * app is meant to use `@uniora/next`'s `createCachedAuthorizationSnapshot`:
 * resolve the real identity/organization server-side, then hand the client
 * a bounded, serializable snapshot (never the storage/engine themselves).
 */
export async function computeDemoSnapshot(role: DemoRoleKey): Promise<AuthorizationSnapshot> {
  const { engine, features, identity, organizationId } = await getDemoAuthorization(role);
  const getSnapshot = createCachedAuthorizationSnapshot(engine, features);

  return getSnapshot({
    identity,
    organizationId,
    permissions: [...DEMO_PERMISSIONS],
    features: [...DEMO_FEATURES],
  });
}
