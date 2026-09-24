import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { PermissionError } from "./repository.js";

describe("PermissionRepository", () => {
  it("register() acepta un key resource.action válido, name y description opcionales", async () => {
    const storage = createMemoryStorage();

    const permission = await storage.permissions.register({
      key: "vehicles.delete",
      name: "Delete Vehicles",
      description: "Allows deleting a vehicle record.",
    });

    expect(permission).toEqual({
      key: "vehicles.delete",
      name: "Delete Vehicles",
      description: "Allows deleting a vehicle record.",
    });
  });

  it("register() funciona sin name/description (ambos opcionales)", async () => {
    const storage = createMemoryStorage();

    const permission = await storage.permissions.register({ key: "vehicles.delete" });

    expect(permission).toEqual({ key: "vehicles.delete", name: undefined, description: undefined });
  });

  it("register() rechaza un key mal formado (sin namespace resource.action)", async () => {
    const storage = createMemoryStorage();

    await expect(storage.permissions.register({ key: "delete" })).rejects.toThrow(PermissionError);
    await expect(storage.permissions.register({ key: "Vehicles.Delete" })).rejects.toThrow(PermissionError);
  });

  it("register() nunca deriva ni normaliza el key — lo rechaza tal cual si es inválido", async () => {
    const storage = createMemoryStorage();

    await expect(storage.permissions.register({ key: " vehicles.delete " })).rejects.toThrow(PermissionError);
  });

  it("register() es un upsert idempotente: re-registrar el mismo key actualiza su definición", async () => {
    const storage = createMemoryStorage();
    await storage.permissions.register({ key: "vehicles.delete", name: "Delete" });

    await storage.permissions.register({ key: "vehicles.delete", name: "Delete Vehicles", description: "..." });

    const found = await storage.permissions.findByKey("vehicles.delete");
    expect(found).toEqual({ key: "vehicles.delete", name: "Delete Vehicles", description: "..." });
  });

  it("findByKey() de un key nunca registrado devuelve null", async () => {
    const storage = createMemoryStorage();

    expect(await storage.permissions.findByKey("vehicles.delete")).toBeNull();
  });

  it("list() lista todo el catálogo", async () => {
    const storage = createMemoryStorage();
    await storage.permissions.register({ key: "vehicles.delete" });
    await storage.permissions.register({ key: "vehicles.create" });

    const catalog = await storage.permissions.list();
    expect(catalog.map((p) => p.key).sort()).toEqual(["vehicles.create", "vehicles.delete"]);
  });

  it("unregister() rechaza un key nunca registrado", async () => {
    const storage = createMemoryStorage();

    await expect(storage.permissions.unregister("vehicles.delete")).rejects.toThrow(PermissionError);
  });

  it("unregister() rechaza un permission todavía otorgado a algún role (cross-tenant blast radius)", async () => {
    const storage = createMemoryStorage();
    await storage.permissions.register({ key: "vehicles.delete" });
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.roles.create({
      id: "role-admin",
      organizationId: "org-1",
      name: "Admin",
      permissionKeys: ["vehicles.delete"],
    });

    await expect(storage.permissions.unregister("vehicles.delete")).rejects.toThrow(PermissionError);

    expect(await storage.permissions.findByKey("vehicles.delete")).not.toBeNull();
  });

  it("unregister() elimina el catálogo una vez que no está otorgado a ningún role", async () => {
    const storage = createMemoryStorage();
    await storage.permissions.register({ key: "vehicles.delete" });
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    const role = await storage.roles.create({
      id: "role-admin",
      organizationId: "org-1",
      name: "Admin",
      permissionKeys: ["vehicles.delete"],
    });
    await storage.roles.revokePermission(role.id, "vehicles.delete");

    await storage.permissions.unregister("vehicles.delete");

    expect(await storage.permissions.findByKey("vehicles.delete")).toBeNull();
  });
  describe("search / count / countRoleGrants", () => {
    it("filtra por substring case-insensitive contra key o name", async () => {
      const storage = createMemoryStorage();
      await storage.permissions.register({ key: "vehicles.delete", name: "Delete vehicles" });
      await storage.permissions.register({ key: "leads.read", name: "View leads" });
      await storage.permissions.register({ key: "reports.export" });

      await expect(storage.permissions.search({ query: "VEHICLES" })).resolves.toMatchObject([{ key: "vehicles.delete" }]);
      await expect(storage.permissions.search({ query: "view" })).resolves.toMatchObject([{ key: "leads.read" }]);
      await expect(storage.permissions.search({ query: "nope" })).resolves.toEqual([]);
      await expect(storage.permissions.count()).resolves.toBe(3);
      await expect(storage.permissions.count({ query: "e" })).resolves.toBe(3);
      await expect(storage.permissions.count({ query: "leads" })).resolves.toBe(1);
    });

    it("pagina con cursor keyset (after = último key) sin huecos ni repeticiones", async () => {
      const storage = createMemoryStorage();
      for (let i = 0; i < 12; i++) {
        await storage.permissions.register({ key: `res${String(i).padStart(2, "0")}.read` });
      }

      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 3; page++) {
        const results = await storage.permissions.search({ limit: 5, after });
        expect(results.length).toBeLessThanOrEqual(5);
        seen.push(...results.map((p) => p.key));
        const last = results.at(-1);
        if (!last) break;
        after = last.key;
      }

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect(seen).toEqual([...seen].sort());
    });

    it("countRoleGrants cuenta roles por key en todas las organizaciones, con 0 para los no otorgados", async () => {
      const storage = createMemoryStorage();
      await storage.permissions.register({ key: "vehicles.delete" });
      await storage.permissions.register({ key: "vehicles.read" });
      await storage.permissions.register({ key: "leads.read" });
      await storage.organizations.create({ id: "org-1", name: "Acme" });
      await storage.organizations.create({ id: "org-2", name: "Beta" });
      await storage.roles.create({ id: "r1", organizationId: "org-1", name: "A", permissionKeys: ["vehicles.delete", "vehicles.read"] });
      await storage.roles.create({ id: "r2", organizationId: "org-2", name: "B", permissionKeys: ["vehicles.delete"] });

      await expect(storage.permissions.countRoleGrants(["vehicles.delete", "vehicles.read", "leads.read"])).resolves.toEqual({
        "vehicles.delete": 2,
        "vehicles.read": 1,
        "leads.read": 0,
      });
    });
  });
});
