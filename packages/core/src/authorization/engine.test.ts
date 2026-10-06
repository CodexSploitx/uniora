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
    await storage.memberships.assignOwnerRole(membership.id, owner.id);

    const engine = createAuthorizationEngine(storage);

    expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
  });

  it("never trusts a role that belongs to a different organization", async () => {
    const storage = createMemoryStorage();
    await storage.roles.create({ id: "role-other-org", organizationId: "org-2", name: "Admin", permissionKeys: ["vehicles.create"] });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    // `MembershipRepository.create`/`assignRole` both reject a cross-org
    // roleId at the source (docs/security-pentest-2026-09-24.md Hallazgo 2)
    // — so a corrupted/forged reference like this can no longer be produced
    // through the public API. Simulate it by mutating the stored object
    // directly (the memory adapter returns live references, not copies),
    // exactly as if the data had been corrupted some other way, to prove
    // the Engine's own defense-in-depth still holds regardless.
    const raw = await storage.memberships.findById(membership.id);
    raw!.roleIds.push("role-other-org");

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

  describe("access.check() without permission or feature (regression — see docs/security-pentest-2026-09-24.md Hallazgo 1)", () => {
    it("denies an identity with no membership anywhere, even one invented by an attacker", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      const engine = createAuthorizationEngine(storage);

      const attacker = { provider: "attacker-controlled", subject: "nobody" };
      const allowed = await engine.access.check({ identity: attacker, organizationId: "org-1" });

      expect(allowed).toBe(false);
    });

    it("denies a legitimate member of a DIFFERENT organization (cross-tenant, INV-001)", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Corp" });
      const owner = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
      const memberOfOrg2 = await storage.memberships.create({ id: "m-2", organizationId: "org-2", identity });
      await storage.memberships.assignOwnerRole(memberOfOrg2.id, owner.id);
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.access.check({ identity, organizationId: "org-1" });

      expect(allowed).toBe(false);
    });

    it("allows an identity that genuinely holds a membership in that organization", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.access.check({ identity, organizationId: "org-1" });

      expect(allowed).toBe(true);
    });
  });

  describe("access.check({ feature }) sin permission (regresión — docs/security-pentest-2026-09-24.md Hallazgo 4)", () => {
    it("deniega a una identidad sin membership aunque el feature esté habilitado en la organización", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      const engine = createAuthorizationEngine(storage);

      const attacker = { provider: "attacker-controlled", subject: "nobody" };
      const allowed = await engine.access.check({ identity: attacker, organizationId: "org-1", feature: "ai_assistant" });

      expect(allowed).toBe(false);
    });

    it("deniega a un miembro legítimo de OTRA organización (cross-tenant) aunque el feature esté habilitado aquí", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Corp" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      const owner = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
      const memberOfOrg2 = await storage.memberships.create({ id: "m-2", organizationId: "org-2", identity });
      await storage.memberships.assignOwnerRole(memberOfOrg2.id, owner.id);
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.access.check({ identity, organizationId: "org-1", feature: "ai_assistant" });

      expect(allowed).toBe(false);
    });

    it("permite a un miembro real de la organización cuando el feature está habilitado", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.access.check({ identity, organizationId: "org-1", feature: "ai_assistant" });

      expect(allowed).toBe(true);
    });
  });

  describe("access.check({ permission: \"\" }) / ({ feature: \"\" }) — regresión, docs/security-pentest-2026-09-24.md Hallazgo 10 (Ronda 4)", () => {
    it("deniega para un permission='' explícito, no lo trata como 'omitido' (permission NO pedido)", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      // Miembro real de la organización, SIN ningún permiso — si `permission: ""`
      // se tratara como "no se pidió permission" (el bug: `if (input.permission)`
      // es falsy para ""), esto caería al chequeo de membership desnudo y
      // devolvería `true` para cualquier miembro real, sin importar el permiso.
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.access.check({ identity, organizationId: "org-1", permission: "" });

      expect(allowed).toBe(false);
    });

    it("deniega para un feature='' explícito, no lo trata como 'omitido'", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.access.check({ identity, organizationId: "org-1", feature: "" });

      expect(allowed).toBe(false);
    });

    it("can() con permission='' deniega igual para un role sin ese permiso (no está protegido solo por access.check)", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      const role = await storage.roles.create({ id: "role-1", organizationId: "org-1", name: "Member", permissionKeys: [] });
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity, roleIds: [role.id] });
      const engine = createAuthorizationEngine(storage);

      const allowed = await engine.can({ identity, organizationId: "org-1", permission: "" });

      expect(allowed).toBe(false);
    });
  });
});

describe("malformed permission keys (audit F-02)", () => {
  async function ownerWorld() {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignOwnerRole(membership.id, "role-owner");
    return storage;
  }

  it.each(["", "NotAKey", "no-dots", undefined, null, 42])("denies the Owner too for the key %j", async (bad) => {
    const engine = createAuthorizationEngine(await ownerWorld());
    expect(await engine.can({ identity, organizationId: "org-1", permission: bad as unknown as string })).toBe(false);
    expect(await engine.access.check({ identity, organizationId: "org-1", permission: bad as unknown as string })).toBe(
      bad === undefined, // omitted permission means "membership only"
    );
  });

  it("still grants the Owner a well-formed key", async () => {
    const engine = createAuthorizationEngine(await ownerWorld());
    expect(await engine.can({ identity, organizationId: "org-1", permission: "anything.at_all" })).toBe(true);
  });
});

describe("onDecision (audit F-05)", () => {
  it("reports every allow and deny exactly once, and a throwing hook never changes the answer", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.roles.create({ id: "r", organizationId: "org-1", name: "Admin", permissionKeys: ["vehicles.create"] });
    await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity, roleIds: ["r"] });

    const seen: Array<{ kind: string; allowed: boolean; reason: string }> = [];
    const engine = createAuthorizationEngine(storage, {
      onDecision: (d) => void seen.push({ kind: d.kind, allowed: d.allowed, reason: d.reason }),
    });
    await engine.can({ identity, organizationId: "org-1", permission: "vehicles.create" });
    await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" });
    await engine.can({ identity, organizationId: "org-1", permission: "" });
    await engine.access.check({ identity, organizationId: "org-1", permission: "vehicles.create" });
    expect(seen).toEqual([
      { kind: "can", allowed: true, reason: "evaluated" },
      { kind: "can", allowed: false, reason: "evaluated" },
      { kind: "can", allowed: false, reason: "malformed_input" },
      { kind: "access.check", allowed: true, reason: "evaluated" },
    ]);

    const noisy = createAuthorizationEngine(storage, {
      onDecision: () => {
        throw new Error("logger down");
      },
    });
    expect(await noisy.can({ identity, organizationId: "org-1", permission: "vehicles.create" })).toBe(true);
  });
});

describe("ownerRequiresRegisteredPermission (audit F-02)", () => {
  async function world() {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.assignOwnerRole(membership.id, "role-owner");
    await storage.permissions.register({ key: "vehicles.delete" });
    return storage;
  }

  it("lets the Owner through registered keys only when enabled", async () => {
    const strict = createAuthorizationEngine(await world(), { ownerRequiresRegisteredPermission: true });
    expect(await strict.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
    expect(await strict.can({ identity, organizationId: "org-1", permission: "vehicles.dleete" })).toBe(false);
    expect(await strict.access.check({ identity, organizationId: "org-1", permission: "vehicles.dleete" })).toBe(false);
  });

  it("keeps the unconditional Owner by default", async () => {
    const lax = createAuthorizationEngine(await world());
    expect(await lax.can({ identity, organizationId: "org-1", permission: "vehicles.dleete" })).toBe(true);
  });
});
