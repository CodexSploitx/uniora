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
    await storage.memberships.assignOwnerRole(membership.id, owner.id);

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

  describe("features requieren membership real (regresión — docs/security-pentest-2026-09-24.md Hallazgo 4)", () => {
    it("una identidad sin membership nunca ve un feature habilitado como true, aunque lo esté para la organización", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      const engine = createAuthorizationEngine(storage);

      const attacker = { provider: "attacker-controlled", subject: "nobody" };
      const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
        identity: attacker,
        organizationId: "org-1",
        features: ["ai_assistant"],
      });

      expect(snapshot.features).toEqual({ ai_assistant: false });
    });

    it("un miembro legítimo de OTRA organización (cross-tenant) tampoco ve el feature como true", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Corp" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      const owner = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
      const memberOfOrg2 = await storage.memberships.create({ id: "m-2", organizationId: "org-2", identity });
      await storage.memberships.assignOwnerRole(memberOfOrg2.id, owner.id);
      const engine = createAuthorizationEngine(storage);

      const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
        identity,
        organizationId: "org-1",
        features: ["ai_assistant"],
      });

      expect(snapshot.features).toEqual({ ai_assistant: false });
    });

    it("un miembro real de la organización sí ve el feature habilitado como true", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      const engine = createAuthorizationEngine(storage);

      const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
        identity,
        organizationId: "org-1",
        features: ["ai_assistant"],
      });

      expect(snapshot.features).toEqual({ ai_assistant: true });
    });
  });
});
