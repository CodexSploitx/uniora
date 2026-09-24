import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { OrganizationError } from "./slug.js";

describe("OrganizationRepository", () => {
  it("crea una organización derivando el slug del nombre", async () => {
    const storage = createMemoryStorage();
    const org = await storage.organizations.create({ id: "org-1", name: "  Acme del Oeste  " });

    expect(org).toMatchObject({ id: "org-1", name: "Acme del Oeste", slug: "acme-del-oeste" });
  });

  it("acepta un slug explícito distinto del derivado del nombre", async () => {
    const storage = createMemoryStorage();
    const org = await storage.organizations.create({ id: "org-1", name: "Acme Motors", slug: "acme" });

    expect(org.slug).toBe("acme");
  });

  it("rechaza un nombre vacío", async () => {
    const storage = createMemoryStorage();
    await expect(storage.organizations.create({ id: "org-1", name: "   " })).rejects.toThrow(OrganizationError);
  });

  it("rechaza un slug explícito mal formado", async () => {
    const storage = createMemoryStorage();
    await expect(
      storage.organizations.create({ id: "org-1", name: "Acme Motors", slug: "Not A Slug" }),
    ).rejects.toThrow(OrganizationError);
  });

  it("rechaza un slug explícito duplicado entre organizaciones", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors", slug: "acme" });

    await expect(
      storage.organizations.create({ id: "org-2", name: "Another Acme", slug: "acme" }),
    ).rejects.toThrow(OrganizationError);
  });

  it("rechaza cuando el slug derivado del nombre ya está en uso", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

    await expect(storage.organizations.create({ id: "org-2", name: "Acme Motors" })).rejects.toThrow(
      OrganizationError,
    );
  });

  it("permite el mismo nombre con un slug explícito distinto", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

    await expect(
      storage.organizations.create({ id: "org-2", name: "Acme Motors", slug: "acme-motors-west" }),
    ).resolves.toMatchObject({ slug: "acme-motors-west" });
  });

  describe("search", () => {
    it("filtra por coincidencia parcial insensible a mayúsculas contra name o slug", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Sunrise Labs", slug: "sunrise" });
      await storage.organizations.create({ id: "org-3", name: "Northwind" });

      await expect(storage.organizations.search({ query: "acme" })).resolves.toMatchObject([{ id: "org-1" }]);
      await expect(storage.organizations.search({ query: "SUN" })).resolves.toMatchObject([{ id: "org-2" }]);
      await expect(storage.organizations.search({ query: "nope" })).resolves.toEqual([]);
    });

    it("respeta el límite y pagina con un cursor keyset sin huecos ni repeticiones", async () => {
      const storage = createMemoryStorage();
      for (let i = 0; i < 12; i++) {
        await storage.organizations.create({ id: `org-${i}`, name: `Org ${i}` });
      }

      const seen: string[] = [];
      let cursor: { createdAt: Date; id: string } | undefined;
      for (let page = 0; page < 3; page++) {
        const results = await storage.organizations.search({ limit: 5, after: cursor });
        expect(results.length).toBeLessThanOrEqual(5);
        seen.push(...results.map((o) => o.id));
        const last = results.at(-1);
        if (!last) break;
        cursor = { createdAt: last.createdAt, id: last.id };
      }

      expect(new Set(seen).size).toBe(12);
      expect(seen).toEqual([...new Set(seen)]);
    });
  });

  describe("count", () => {
    it("cuenta todas las organizaciones sin query, o solo las que matchean", async () => {
      const storage = createMemoryStorage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Sunrise Labs" });

      await expect(storage.organizations.count()).resolves.toBe(2);
      await expect(storage.organizations.count({ query: "acme" })).resolves.toBe(1);
      await expect(storage.organizations.count({ query: "nope" })).resolves.toBe(0);
    });
  });
  describe("conteos por lote (Overview / lista de organizaciones)", () => {
    it("count y countByOrganization de memberships, roles y features habilitadas, con 0 para ids sin filas", async () => {
      const storage = createMemoryStorage();
      await storage.features.register({ name: "Reports", key: "reports" });
      for (const id of ["o1", "o2", "o3"]) await storage.organizations.create({ id, name: `Org ${id}` });
      await storage.roles.create({ id: "r1", organizationId: "o1", name: "A" });
      await storage.roles.create({ id: "r2", organizationId: "o2", name: "B" });
      await storage.memberships.create({ id: "m1", organizationId: "o1", identity: { provider: "supabase", subject: "u1" } });
      await storage.features.enable("o1", "reports");
      await storage.features.disable("o2", "reports");

      const ids = ["o1", "o2", "o3", "ghost"];
      await expect(storage.memberships.countByOrganization(ids)).resolves.toEqual({ o1: 1, o2: 0, o3: 0, ghost: 0 });
      await expect(storage.roles.countByOrganization(ids)).resolves.toEqual({ o1: 1, o2: 1, o3: 0, ghost: 0 });
      await expect(storage.features.countEnabledByOrganization(ids)).resolves.toEqual({ o1: 1, o2: 0, o3: 0, ghost: 0 });
      await expect(storage.memberships.count()).resolves.toBe(1);
      await expect(storage.roles.count()).resolves.toBe(2);
    });
  });

  describe("vistas de detalle de una organización (búsqueda paginada, sin cargar todo)", () => {
    it("miembros, roles, permisos por rol, features habilitadas y auditoría por organización", async () => {
      const storage = createMemoryStorage();

        const identity = (subject: string) => ({ provider: "supabase", subject });
        await storage.permissions.register({ key: "a.read" });
        await storage.permissions.register({ key: "b.read" });
        await storage.permissions.register({ key: "c.read" });
        await storage.features.register({ name: "Alpha", key: "alpha" });
        await storage.features.register({ name: "Beta", key: "beta" });
        for (const id of ["o1", "o2"]) await storage.organizations.create({ id, name: `Org ${id}` });
        await storage.roles.create({ id: "r1", organizationId: "o1", name: "Editor", key: "editor", permissionKeys: ["a.read", "b.read"] });
        await storage.roles.create({ id: "r2", organizationId: "o1", name: "Viewer", key: "viewer", permissionKeys: ["a.read"] });
        await storage.roles.create({ id: "r3", organizationId: "o2", name: "Editor", key: "editor" });
        for (let i = 0; i < 7; i++) {
          await storage.memberships.create({ id: `m${i}`, organizationId: "o1", identity: identity(`user-${i}`), roleIds: i < 3 ? ["r1"] : [] });
        }
        await storage.memberships.create({ id: "mx", organizationId: "o2", identity: { provider: "clerk", subject: "other" }, roleIds: ["r3"] });

        // --- members: scoped + global search, keyset, filters, counts, findById
        await expect(storage.memberships.count()).resolves.toBe(8);
        await expect(storage.memberships.count({ organizationId: "o1" })).resolves.toBe(7);
        await expect(storage.memberships.count({ organizationId: "o1", query: "USER-3" })).resolves.toBe(1);
        await expect(storage.memberships.count({ query: "clerk" })).resolves.toBe(1);
        const seen: string[] = [];
        let after: string | undefined;
        for (let page = 0; page < 5; page++) {
          const rows = await storage.memberships.search({ organizationId: "o1", limit: 3, after });
          expect(rows.every((m) => m.organizationId === "o1")).toBe(true);
          seen.push(...rows.map((m) => m.id));
          const last = rows.at(-1);
          if (!last) break;
          after = last.id;
        }
        expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
        const global = await storage.memberships.search({ limit: 50 });
        expect(global.map((m) => m.id)).toContain("mx");
        const m0 = await storage.memberships.findById("m0");
        expect(m0).toMatchObject({ id: "m0", roleIds: ["r1"] });
        await expect(storage.memberships.findById("ghost")).resolves.toBeNull();
        await expect(storage.memberships.countByRole(["r1", "r2", "nope"])).resolves.toEqual({ r1: 3, r2: 0, nope: 0 });

        // --- roles: summaries, scoped search/keyset, counts, granted keys
        const summaries = await storage.roles.findSummariesByIds(["r1", "ghost"]);
        expect(summaries).toEqual([{ id: "r1", organizationId: "o1", name: "Editor", key: "editor", isOwnerRole: false }]);
        expect(Object.keys(summaries[0]!)).not.toContain("permissionKeys");
        await expect(storage.roles.search({ organizationId: "o1" })).resolves.toMatchObject([{ key: "editor" }, { key: "viewer" }]);
        await expect(storage.roles.search({ organizationId: "o1", limit: 1, after: "editor" })).resolves.toMatchObject([{ key: "viewer" }]);
        await expect(storage.roles.search({ organizationId: "o1", query: "VIEW" })).resolves.toMatchObject([{ key: "viewer" }]);
        await expect(storage.roles.count({ organizationId: "o1" })).resolves.toBe(2);
        await expect(storage.roles.count({ organizationId: "o1", query: "edit" })).resolves.toBe(1);
        await expect(storage.roles.count()).resolves.toBe(3);
        await expect(storage.roles.countPermissions(["r1", "r2", "r3"])).resolves.toEqual({ r1: 2, r2: 1, r3: 0 });
        expect((await storage.roles.grantedPermissionKeys("r1", ["a.read", "b.read", "c.read"])).sort()).toEqual(["a.read", "b.read"]);
        await expect(storage.roles.grantedPermissionKeys("r1", [])).resolves.toEqual([]);

        // --- permissions filtered by role (page of the role's own permissions)
        await expect(storage.permissions.search({ grantedToRole: "r2" })).resolves.toMatchObject([{ key: "a.read" }]);
        await expect(storage.permissions.count({ grantedToRole: "r1" })).resolves.toBe(2);
        await expect(storage.permissions.count({ grantedToRole: "r1", query: "b." })).resolves.toBe(1);

        // --- features enabled in one organization
        await storage.features.enable("o1", "alpha");
        await storage.features.disable("o1", "beta");
        await expect(storage.features.search({ enabledIn: "o1" })).resolves.toMatchObject([{ key: "alpha" }]);
        await expect(storage.features.count({ enabledIn: "o1" })).resolves.toBe(1);
        await expect(storage.features.count({ enabledIn: "o2" })).resolves.toBe(0);
        await expect(storage.features.enabledKeys("o1", ["alpha", "beta"])).resolves.toEqual(["alpha"]);
        await expect(storage.features.enabledKeys("o1", [])).resolves.toEqual([]);

        // --- per-organization audit log keyset paging (no gaps / repeats)
        for (let i = 0; i < 7; i++) {
          await storage.auditLogs.record({ id: `log-${i}`, organizationId: "o1", actor: identity("admin"), action: "role.created" });
        }
        await storage.auditLogs.record({ id: "log-other", organizationId: "o2", actor: identity("admin"), action: "role.created" });
        const logIds: string[] = [];
        let before: { createdAt: Date; id: string } | undefined;
        for (let page = 0; page < 5; page++) {
          const rows = await storage.auditLogs.listByOrganization("o1", { limit: 3, before });
          logIds.push(...rows.map((e) => e.id));
          const last = rows.at(-1);
          if (!last) break;
          before = { createdAt: last.createdAt, id: last.id };
        }
        expect(logIds).toHaveLength(7);
        expect(new Set(logIds).size).toBe(7);
        expect(logIds).not.toContain("log-other");
    });
  });

  describe("miembros con muchos roles (listado acotado)", () => {
    it("searchListing devuelve una vista previa acotada + el total, y heldBy/notHeldBy filtran en el servidor", async () => {
      const storage = createMemoryStorage();

      await storage.organizations.create({ id: "o1", name: "Org o1" });
      await storage.roles.createOwnerRole({ id: "owner", organizationId: "o1" });
      for (let i = 1; i <= 12; i++) {
        await storage.roles.create({ id: `r${i}`, organizationId: "o1", name: `Role ${String(i).padStart(2, "0")}`, key: `role-${String(i).padStart(2, "0")}` });
      }
      const held = ["owner", ...Array.from({ length: 9 }, (_, i) => `r${i + 1}`)]; // owner + r1..r9  (10 roles)
      await storage.memberships.create({ id: "many", organizationId: "o1", identity: { provider: "supabase", subject: "many" }, roleIds: held });
      await storage.memberships.create({ id: "few", organizationId: "o1", identity: { provider: "supabase", subject: "few" }, roleIds: ["r5"] });
      await storage.memberships.create({ id: "none", organizationId: "o1", identity: { provider: "supabase", subject: "none" } });

      // listing: bounded preview (Owner first, then by name) + the real total, never every role
      const listing = await storage.memberships.searchListing({ organizationId: "o1", limit: 10, rolesPerMember: 3 });
      const byId = Object.fromEntries(listing.map((m) => [m.id, m]));
      expect(byId["many"]!.roleCount).toBe(10);
      expect(byId["many"]!.roles.map((r) => r.id)).toEqual(["owner", "r1", "r2"]);
      expect(byId["few"]).toMatchObject({ roleCount: 1, roles: [{ id: "r5", name: "Role 05" }] });
      expect(byId["none"]).toMatchObject({ roleCount: 0, roles: [] });
      expect(Object.keys(byId["many"]!.roles[0]!)).not.toContain("permissionKeys");
      await expect(storage.memberships.searchListing({ organizationId: "o1", limit: 1, after: "many", rolesPerMember: 3 })).resolves.toMatchObject([{ id: "none" }]);

      // "all roles of this member" (popover) and "roles I can still add" (picker), both server-side filters
      await expect(storage.roles.count({ organizationId: "o1", heldBy: "many" })).resolves.toBe(10);
      const heldPage = await storage.roles.search({ organizationId: "o1", heldBy: "many", limit: 4 });
      expect(heldPage).toHaveLength(4);
      await expect(storage.roles.search({ organizationId: "o1", heldBy: "many", query: "role 03" })).resolves.toMatchObject([{ id: "r3" }]);
      const addable = await storage.roles.search({ organizationId: "o1", notHeldBy: "many" });
      expect(addable.map((r) => r.id).sort()).toEqual(["r10", "r11", "r12"]);
      await expect(storage.roles.count({ organizationId: "o1", notHeldBy: "many" })).resolves.toBe(3);
    });
  });

  describe("ficha de un miembro (organizaciones, permisos efectivos, por qué)", () => {
    it("identidad en varias organizaciones, permisos efectivos vía roles y roles que los conceden", async () => {
      const storage = createMemoryStorage();

      await storage.permissions.register({ key: "a.read" });
      await storage.permissions.register({ key: "b.read" });
      await storage.permissions.register({ key: "c.read" });
      await storage.permissions.register({ key: "d.read" });
      for (const id of ["o1", "o2"]) await storage.organizations.create({ id, name: `Org ${id}` });
      await storage.roles.createOwnerRole({ id: "owner", organizationId: "o1" });
      await storage.roles.create({ id: "r1", organizationId: "o1", name: "Editor", key: "editor", permissionKeys: ["a.read", "b.read"] });
      await storage.roles.create({ id: "r2", organizationId: "o1", name: "Auditor", key: "auditor", permissionKeys: ["b.read", "c.read"] });
      await storage.roles.create({ id: "r3", organizationId: "o1", name: "Empty", key: "empty" });
      await storage.roles.create({ id: "x1", organizationId: "o2", name: "Other", key: "other", permissionKeys: ["d.read"] });
      const me = { provider: "supabase", subject: "me" };
      await storage.memberships.create({ id: "m-o1", organizationId: "o1", identity: me, roleIds: ["r1", "r2", "r3"] });
      await storage.memberships.create({ id: "m-o2", organizationId: "o2", identity: me, roleIds: ["x1"] });
      await storage.memberships.create({ id: "m-owner", organizationId: "o1", identity: { provider: "clerk", subject: "boss" }, roleIds: ["owner"] });

      // every membership of ONE identity, across organizations (exact match, not substring)
      const mine = await storage.memberships.search({ identity: me, limit: 10 });
      expect(mine.map((m) => m.id).sort()).toEqual(["m-o1", "m-o2"]);
      await expect(storage.memberships.count({ identity: me })).resolves.toBe(2);
      await expect(storage.memberships.count({ identity: { provider: "supabase", subject: "m" } })).resolves.toBe(0);
      const listing = await storage.memberships.searchListing({ identity: me, limit: 10, rolesPerMember: 1 });
      expect(listing.map((m) => m.id).sort()).toEqual(["m-o1", "m-o2"]);

      // effective permissions of a member = union over ALL held roles
      expect((await storage.permissions.search({ grantedToMember: "m-o1" })).map((p) => p.key)).toEqual(["a.read", "b.read", "c.read"]);
      await expect(storage.permissions.count({ grantedToMember: "m-o1" })).resolves.toBe(3);
      await expect(storage.permissions.count({ grantedToMember: "m-o1", query: "b." })).resolves.toBe(1);
      await expect(storage.permissions.search({ grantedToMember: "m-o2" })).resolves.toMatchObject([{ key: "d.read" }]);
      await expect(storage.permissions.count({ grantedToMember: "m-owner" })).resolves.toBe(0); // Owner = flag, not a list

      // WHY: which held roles grant each permission (bounded preview + real total)
      const why = await storage.roles.grantingRoles("m-o1", ["a.read", "b.read", "d.read"], 1);
      expect(why["a.read"]).toMatchObject({ total: 1, roles: [{ id: "r1" }] });
      expect(why["b.read"]!.total).toBe(2);
      expect(why["b.read"]!.roles).toHaveLength(1);
      expect(why["b.read"]!.roles[0]!.name).toBe("Auditor");
      expect(why["d.read"]).toEqual({ total: 0, roles: [] });
      await expect(storage.roles.grantingRoles("m-o1", [], 3)).resolves.toEqual({});

      // Owner detection without loading the member's roles
      await expect(storage.roles.count({ organizationId: "o1", heldBy: "m-owner", isOwnerRole: true })).resolves.toBe(1);
      await expect(storage.roles.count({ organizationId: "o1", heldBy: "m-o1", isOwnerRole: true })).resolves.toBe(0);
      await expect(storage.roles.count({ organizationId: "o1", isOwnerRole: false })).resolves.toBe(3);
    });
  });
});
