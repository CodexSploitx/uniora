import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import { RoleError } from "./repository.js";

describe("RoleRepository", () => {
  it("crea roles custom con isOwnerRole en false", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

    expect(role.isOwnerRole).toBe(false);
  });

  it("rechaza crear un role con nombre duplicado en la misma organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

    await expect(
      storage.roles.create({ id: "role-sales-2", organizationId: "org-1", name: "Sales" }),
    ).rejects.toThrow(RoleError);
  });

  it("deriva el key a partir del nombre cuando no se pasa uno explícito", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    const role = await storage.roles.create({ id: "role-billing", organizationId: "org-1", name: "Billing Manager" });

    expect(role.key).toBe("billing-manager");
  });

  it("acepta un key explícito distinto del derivado del nombre", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    const role = await storage.roles.create({
      id: "role-billing",
      organizationId: "org-1",
      name: "Billing Manager",
      key: "billing",
    });

    expect(role.key).toBe("billing");
  });

  it("rechaza un key explícito mal formado", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    await expect(
      storage.roles.create({ id: "role-billing", organizationId: "org-1", name: "Billing", key: "Not Valid" }),
    ).rejects.toThrow(RoleError);
  });

  it('rechaza un key reservado ("owner") aunque el nombre sea distinto al del Owner role', async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    await expect(
      storage.roles.create({ id: "role-fake-owner", organizationId: "org-1", name: "Founder", key: "owner" }),
    ).rejects.toThrow(RoleError);
  });

  it("rechaza dos roles cuyo key derivado colisiona, aunque el nombre difiera", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.roles.create({ id: "role-1", organizationId: "org-1", name: "Billing!" });

    await expect(
      storage.roles.create({ id: "role-2", organizationId: "org-1", name: "Billing?" }),
    ).rejects.toThrow(RoleError);
  });

  it("permite el mismo key de role en organizaciones distintas", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Other" });
    await storage.roles.create({ id: "role-1", organizationId: "org-1", name: "Billing", key: "billing" });

    await expect(
      storage.roles.create({ id: "role-2", organizationId: "org-2", name: "Billing", key: "billing" }),
    ).resolves.toMatchObject({ key: "billing" });
  });

  it("descarta permissionKeys duplicados al crear", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    const role = await storage.roles.create({
      id: "role-sales",
      organizationId: "org-1",
      name: "Sales",
      permissionKeys: ["leads.read", "leads.read"],
    });

    expect(role.permissionKeys).toEqual(["leads.read"]);
  });

  it("rechaza un permissionKey vacío al crear", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });

    await expect(
      storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales", permissionKeys: [""] }),
    ).rejects.toThrow(RoleError);
  });

  it("renombrar un role nunca cambia su key", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

    const renamed = await storage.roles.rename(role.id, "Sales Team");

    expect(renamed.key).toBe(role.key);
    expect(renamed.key).toBe("sales");
  });

  it("permite el mismo nombre de role en organizaciones distintas", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Other" });
    await storage.roles.create({ id: "role-1", organizationId: "org-1", name: "Sales" });

    await expect(
      storage.roles.create({ id: "role-2", organizationId: "org-2", name: "Sales" }),
    ).resolves.toMatchObject({ name: "Sales" });
  });

  it("otorga y revoca permisos de un role custom", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

    await storage.roles.grantPermission(role.id, "leads.read");
    expect((await storage.roles.findByIds([role.id]))[0]?.permissionKeys).toEqual(["leads.read"]);

    await storage.roles.revokePermission(role.id, "leads.read");
    expect((await storage.roles.findByIds([role.id]))[0]?.permissionKeys).toEqual([]);
  });

  it("revocar un permiso no otorgado es un no-op idempotente", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

    await expect(storage.roles.revokePermission(role.id, "leads.read")).resolves.toBeUndefined();
  });

  it("renombra un role custom, rechazando colisión de nombre", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.roles.create({ id: "role-admin", organizationId: "org-1", name: "Admin" });
    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

    const renamed = await storage.roles.rename(role.id, "Sales Team");
    expect(renamed.name).toBe("Sales Team");

    await expect(storage.roles.rename(role.id, "Admin")).rejects.toThrow(RoleError);
  });

  it("borra un role custom y lo desasigna de cualquier membership que lo tuviera", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });
    const identity = { provider: "supabase", subject: "user-1" };
    const membership = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [role.id],
    });

    await storage.roles.delete(role.id);

    expect(await storage.roles.findByIds([role.id])).toEqual([]);
    const found = await storage.memberships.findByIdentity("org-1", identity);
    expect(found?.id).toBe(membership.id);
    expect(found?.roleIds).toEqual([]);
  });

  it("operar sobre un role inexistente falla con RoleError", async () => {
    const storage = createMemoryStorage();
    await expect(storage.roles.grantPermission("no-such-role", "leads.read")).rejects.toThrow(RoleError);
    await expect(storage.roles.revokePermission("no-such-role", "leads.read")).rejects.toThrow(RoleError);
    await expect(storage.roles.rename("no-such-role", "New Name")).rejects.toThrow(RoleError);
    await expect(storage.roles.delete("no-such-role")).rejects.toThrow(RoleError);
  });

  describe("Owner role protection", () => {
    it("createOwnerRole crea un role con isOwnerRole true, nombre 'Owner' y sin permissionKeys", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme" });

      const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });

      expect(owner).toMatchObject({ isOwnerRole: true, key: "owner", name: "Owner", permissionKeys: [] });
    });

    it("rechaza crear un segundo Owner role para la misma organización", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme" });
      await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });

      await expect(
        storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-1" }),
      ).rejects.toThrow(RoleError);
    });

    it("permite un Owner role por cada organización", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme" });
      await storage.organizations.create({ id: "org-2", name: "Other" });

      await expect(
        storage.roles.createOwnerRole({ id: "role-owner-1", organizationId: "org-1" }),
      ).resolves.toMatchObject({ isOwnerRole: true });
      await expect(
        storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" }),
      ).resolves.toMatchObject({ isOwnerRole: true });
    });

    it("rechaza renombrar, borrar, otorgar o revocar permisos del Owner role", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme" });
      const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });

      await expect(storage.roles.rename(owner.id, "Not Owner")).rejects.toThrow(RoleError);
      await expect(storage.roles.grantPermission(owner.id, "vehicles.delete")).rejects.toThrow(RoleError);
      await expect(storage.roles.revokePermission(owner.id, "vehicles.delete")).rejects.toThrow(RoleError);
      await expect(storage.roles.delete(owner.id)).rejects.toThrow(RoleError);

      // Nada de lo anterior debe haber mutado el role.
      const [stillOwner] = await storage.roles.findByIds([owner.id]);
      expect(stillOwner).toMatchObject({ isOwnerRole: true, name: "Owner", permissionKeys: [] });
    });

    it("el Owner role otorga cualquier permiso a través del AuthorizationEngine, aunque nunca se haya otorgado explícitamente", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme" });
      const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
      const identity = { provider: "supabase", subject: "user-1" };
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      await storage.memberships.assignRole(membership.id, owner.id);

      const engine = createAuthorizationEngine(storage);

      expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
      expect(await engine.can({ identity, organizationId: "org-1", permission: "anything.at.all" })).toBe(true);
    });

    it("el Owner role de otra organización nunca otorga acceso cruzado (INV-001)", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme" });
      await storage.organizations.create({ id: "org-2", name: "Other" });
      const owner = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
      const identity = { provider: "supabase", subject: "user-1" };
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      // Simula un roleId forjado/corrupto apuntando al Owner role de otra organización.
      await storage.memberships.assignRole(membership.id, owner.id);

      const engine = createAuthorizationEngine(storage);

      expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(false);
    });
  });
});
