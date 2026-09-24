import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createAuthorizationEngine } from "./engine.js";
import { computeAuthorizationSnapshot } from "./snapshot.js";

const identity = { provider: "supabase", subject: "user-1" };

describe("computeAuthorizationSnapshot", () => {
  it("resuelve solo los permissions/features pedidos, cada uno con su valor real del engine", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.roles.create({
      id: "role-sales",
      organizationId: "org-1",
      name: "Sales",
      permissionKeys: ["vehicles.read"],
    });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignRole(membership.id, "role-sales");
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
    await storage.features.enable("org-1", "advanced_reports");

    const engine = createAuthorizationEngine(storage);
    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity,
      organizationId: "org-1",
      permissions: ["vehicles.read", "vehicles.delete"],
      features: ["advanced_reports", "ai_assistant"],
    });

    expect(snapshot).toEqual({
      organizationId: "org-1",
      permissions: { "vehicles.read": true, "vehicles.delete": false },
      features: { advanced_reports: true, ai_assistant: false },
    });
  });

  it("nunca enumera un permiso no pedido, ni siquiera para el Owner role (fail-closed por diseño)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignRole(membership.id, owner.id);

    const engine = createAuthorizationEngine(storage);
    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity,
      organizationId: "org-1",
      permissions: ["vehicles.delete"],
    });

    // Owner bypass still applies per-key via engine.can() — but nothing
    // beyond the requested key is ever present in the snapshot.
    expect(snapshot.permissions).toEqual({ "vehicles.delete": true });
  });

  it("sin permissions/features pedidos devuelve objetos vacíos, nunca lanza", async () => {
    const storage = createMemoryStorage();
    const engine = createAuthorizationEngine(storage);

    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity,
      organizationId: "org-1",
    });

    expect(snapshot).toEqual({ organizationId: "org-1", permissions: {}, features: {} });
  });

  it("sin membership, todos los permissions pedidos resuelven a false (deny-by-default)", async () => {
    const storage = createMemoryStorage();
    const engine = createAuthorizationEngine(storage);

    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity,
      organizationId: "org-1",
      permissions: ["vehicles.read"],
    });

    expect(snapshot.permissions).toEqual({ "vehicles.read": false });
  });
});
