import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createAuthorizationEngine } from "./engine.js";

const identity = { provider: "supabase", subject: "user-1" };

describe("createAuthorizationEngine", () => {
  it("denies by default when there is no membership", async () => {
    const storage = createMemoryStorage();
    const engine = createAuthorizationEngine(storage);

    const allowed = await engine.can({ identity, organizationId: "org-1", permission: "vehicles.create" });

    expect(allowed).toBe(false);
  });

  it("allows the action when a role in the same org grants the permission", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.roles.create({ id: "role-admin", organizationId: "org-1", name: "Admin", permissionKeys: ["vehicles.create"] });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignRole(membership.id, "role-admin");

    const engine = createAuthorizationEngine(storage);
    const allowed = await engine.can({ identity, organizationId: "org-1", permission: "vehicles.create" });

    expect(allowed).toBe(true);
  });

  it("grants every permission unconditionally when the membership's role is the protected Owner role", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignRole(membership.id, owner.id);

    const engine = createAuthorizationEngine(storage);

    expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
  });

  it("never trusts a role that belongs to a different organization", async () => {
    const storage = createMemoryStorage();
    await storage.roles.create({ id: "role-other-org", organizationId: "org-2", name: "Admin", permissionKeys: ["vehicles.create"] });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    // Simulates a corrupted/forged roleId pointing at another org's role.
    await storage.memberships.assignRole(membership.id, "role-other-org");

    const engine = createAuthorizationEngine(storage);
    const allowed = await engine.can({ identity, organizationId: "org-1", permission: "vehicles.create" });

    expect(allowed).toBe(false);
  });

  it("requires both the feature and the permission for access.check", async () => {
    const storage = createMemoryStorage();
    await storage.roles.create({ id: "role-admin", organizationId: "org-1", name: "Admin", permissionKeys: ["vehicles.delete"] });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignRole(membership.id, "role-admin");

    const engine = createAuthorizationEngine(storage);

    expect(
      await engine.access.check({ identity, organizationId: "org-1", permission: "vehicles.delete", feature: "advanced_inventory" }),
    ).toBe(false);

    await storage.features.register({ key: "advanced_inventory", name: "Advanced Inventory" });
    await storage.features.enable("org-1", "advanced_inventory");

    expect(
      await engine.access.check({ identity, organizationId: "org-1", permission: "vehicles.delete", feature: "advanced_inventory" }),
    ).toBe(true);
  });
});
