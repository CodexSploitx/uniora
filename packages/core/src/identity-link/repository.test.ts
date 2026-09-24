import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import { IdentityLinkError } from "./repository.js";

const oldIdentity = { provider: "supabase", subject: "user-1" };
const newIdentity = { provider: "clerk", subject: "user-1-clerk" };

describe("IdentityLinkRepository", () => {
  it("resuelve una identidad linkeada a su identidad canónica", async () => {
    const storage = createMemoryStorage();

    const link = await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });

    expect(link.from).toEqual(newIdentity);
    expect(link.to).toEqual(oldIdentity);
    expect(await storage.identityLinks.resolve(newIdentity)).toEqual(oldIdentity);
  });

  it("devuelve la misma identidad sin cambios si no tiene link", async () => {
    const storage = createMemoryStorage();
    expect(await storage.identityLinks.resolve(oldIdentity)).toEqual(oldIdentity);
  });

  it("es idempotente: relinkear exactamente el mismo par no falla", async () => {
    const storage = createMemoryStorage();
    await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });

    await expect(
      storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity }),
    ).resolves.toMatchObject({ from: newIdentity, to: oldIdentity });
  });

  it("rechaza linkear una identidad a sí misma", async () => {
    const storage = createMemoryStorage();
    await expect(
      storage.identityLinks.link({ from: oldIdentity, to: oldIdentity, actor: oldIdentity }),
    ).rejects.toThrow(IdentityLinkError);
  });

  it("rechaza si 'from' ya tiene una membership propia (anti-secuestro)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    // newIdentity ya tiene su propia membership real, independiente.
    await storage.memberships.create({ id: "m-attacker", organizationId: "org-1", identity: newIdentity });

    await expect(
      storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity }),
    ).rejects.toThrow(IdentityLinkError);
  });

  it("rechaza relinkear 'from' a un 'to' distinto del ya existente", async () => {
    const storage = createMemoryStorage();
    const anotherIdentity = { provider: "auth0", subject: "user-1-auth0" };
    await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });

    await expect(
      storage.identityLinks.link({ from: newIdentity, to: anotherIdentity, actor: oldIdentity }),
    ).rejects.toThrow(IdentityLinkError);
  });

  it("rechaza encadenar links: 'to' no puede ser a su vez un 'from'", async () => {
    const storage = createMemoryStorage();
    const thirdIdentity = { provider: "auth0", subject: "user-1-auth0" };
    await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });

    await expect(
      storage.identityLinks.link({ from: thirdIdentity, to: newIdentity, actor: oldIdentity }),
    ).rejects.toThrow(IdentityLinkError);
  });

  it("findByIdentity y el AuthorizationEngine resuelven la identidad nueva sin re-otorgar nada", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.roles.create({
      id: "role-admin",
      organizationId: "org-1",
      name: "Admin",
      permissionKeys: ["vehicles.delete"],
    });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity: oldIdentity });
    await storage.memberships.assignRole(membership.id, "role-admin");

    const engine = createAuthorizationEngine(storage);
    // Antes de migrar: la identidad vieja sí tiene el permiso, la nueva no.
    expect(await engine.can({ identity: oldIdentity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
    expect(await engine.can({ identity: newIdentity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(false);

    await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });

    // Después de migrar: la identidad nueva hereda el mismo membership/roles.
    const found = await storage.memberships.findByIdentity("org-1", newIdentity);
    expect(found?.id).toBe(membership.id);
    expect(await engine.can({ identity: newIdentity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
  });
});
