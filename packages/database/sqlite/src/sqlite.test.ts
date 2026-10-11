import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrganizationWithOwner, MembershipError } from "@uniora/core";
import { applyMigrations } from "./migrate.js";
import { createSqliteStorage } from "./storage.js";
import { unioraIlike } from "./like.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = { provider: "supabase", subject: "user-1" };

describe("@uniora/sqlite — particularidades del adaptador", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("conexión", () => {
    it("activa foreign_keys en una conexión que las traía apagadas (SQLite las apaga por defecto)", () => {
      db.pragma("foreign_keys = OFF");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(0);

      createSqliteStorage(db);

      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });

    it("se niega a funcionar si no puede garantizar las foreign keys (transacción abierta con ellas apagadas)", () => {
      db.pragma("foreign_keys = OFF");
      db.exec("begin");

      expect(() => createSqliteStorage(db)).toThrow(/foreign.key/i);
    });

    it("las foreign keys son reales: un membership no puede apuntar a una organización inexistente", async () => {
      const storage = createSqliteStorage(db);

      await expect(
        storage.memberships.create({ id: "m-1", organizationId: "org-fantasma", identity }),
      ).rejects.toThrow(/FOREIGN KEY/);
    });
  });

  describe("constraints de esquema (la base, no solo la aplicación)", () => {
    it.each(["nodot", "Vehicles.Delete", "a..b", ".a.b", "a.b.", "a.b c", "a.b-c", ""])(
      "rechaza el permission key mal formado %j directamente en la tabla",
      (key) => {
        expect(() => db.prepare("insert into uniora_permissions (key) values (?)").run(key)).toThrow(/CHECK constraint/);
      },
    );

    it.each(["a.b", "vehicles.delete", "a_1.b2.c_3", "x9.y"])("acepta el permission key bien formado %j", (key) => {
      expect(() => db.prepare("insert into uniora_permissions (key) values (?)").run(key)).not.toThrow();
    });

    it("garantiza un único Owner role por organización con un índice parcial real", () => {
      db.exec("insert into uniora_organizations (id, name, slug) values ('o', 'O', 'o')");
      db.exec("insert into uniora_roles (id, organization_id, name, name_normalized, key, is_owner_role) values ('r1', 'o', 'Owner', 'owner', 'owner', 1)");

      expect(() =>
        db.exec("insert into uniora_roles (id, organization_id, name, name_normalized, key, is_owner_role) values ('r2', 'o', 'Boss', 'boss', 'boss', 1)"),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        db.exec("insert into uniora_roles (id, organization_id, name, name_normalized, key, is_owner_role) values ('r3', 'o', 'Sales', 'sales', 'sales', 0)"),
      ).not.toThrow();
    });

    it("los timestamps son ISO-8601 con milisegundos, idénticos a Date#toISOString (sin truncado de cursores)", async () => {
      const storage = createSqliteStorage(db);
      const organization = await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      const entry = await storage.auditLogs.record({ id: "log-1", organizationId: "org-1", actor: identity, action: "role.created" });

      const stored = db.prepare("select created_at from uniora_organizations where id = 'org-1'").get() as { created_at: string };
      expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(organization.createdAt.toISOString()).toBe(stored.created_at);
      expect(entry.createdAt.toISOString()).toMatch(/\.\d{3}Z$/);

      const row = db.prepare("select created_at from uniora_audit_logs where id = 'log-1'").get() as { created_at: string };
      expect(entry.createdAt.toISOString()).toBe(row.created_at);
    });
  });

  describe("búsqueda (ILIKE de Postgres sobre SQLite)", () => {
    it("pliega mayúsculas Unicode, no solo ASCII (el LIKE nativo de SQLite no lo haría)", async () => {
      const storage = createSqliteStorage(db);
      await storage.organizations.create({ id: "org-1", name: "Ñandú Motors", slug: "nandu" });
      await storage.organizations.create({ id: "org-2", name: "Otra", slug: "otra" });

      await expect(storage.organizations.search({ query: "ñANDÚ" })).resolves.toMatchObject([{ id: "org-1" }]);
      await expect(storage.organizations.count({ query: "ñandú" })).resolves.toBe(1);
    });

    it("unioraIlike: comodines literales escapados, NULL nunca coincide, _ y % son comodines sin escapar", () => {
      expect(unioraIlike("100% real", "%100\\%%")).toBe(1);
      expect(unioraIlike("100 real", "%100\\%%")).toBe(0);
      expect(unioraIlike("a_b", "%a\\_b%")).toBe(1);
      expect(unioraIlike("axb", "%a\\_b%")).toBe(0);
      expect(unioraIlike("axb", "a_b")).toBe(1);
      expect(unioraIlike("a.b (x)", "%a.b (x)%")).toBe(1);
      expect(unioraIlike("a+b", "%a.b%")).toBe(0);
      expect(unioraIlike(null, "%a%")).toBe(0);
      expect(unioraIlike("a", null)).toBe(0);
      expect(unioraIlike("😀 emoji", "_ emoji")).toBe(1);
    });
  });

  describe("serialización de la conexión", () => {
    it("una operación suelta lanzada durante una transacción abierta espera y NO se une a ella (ni se revierte con ella)", async () => {
      const storage = createSqliteStorage(db);

      const failing = storage.transaction(async (tx) => {
        await tx.organizations.create({ id: "org-inside", name: "Inside" });
        await sleep(30);
        throw new Error("boom");
      });
      await sleep(5); // la transacción ya está abierta
      const outside = storage.organizations.create({ id: "org-outside", name: "Outside" });

      await expect(failing).rejects.toThrow("boom");
      await expect(outside).resolves.toMatchObject({ id: "org-outside" });

      expect(await storage.organizations.findById("org-inside")).toBeNull();
      expect(await storage.organizations.findById("org-outside")).not.toBeNull();
    });

    it("llamar al storage de nivel superior DENTRO del callback de transaction() se une a ella en vez de bloquearse para siempre", async () => {
      const storage = createSqliteStorage(db);

      await expect(
        storage.transaction(async () => {
          await storage.organizations.create({ id: "org-1", name: "Acme" });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(await storage.organizations.findById("org-1")).toBeNull();
    });

    it("una operación que falla a medias dentro de una transacción deshace solo lo suyo (savepoint) y la transacción sigue", async () => {
      const storage = createSqliteStorage(db);
      await storage.organizations.create({ id: "org-1", name: "Acme" });

      await storage.transaction(async (tx) => {
        await tx.organizations.create({ id: "org-2", name: "Kept" });
        // El role se inserta y LUEGO falla su permiso (FK a un permission no registrado).
        await expect(
          tx.roles.create({ id: "role-x", organizationId: "org-1", name: "X", permissionKeys: ["not.registered"] }),
        ).rejects.toThrow(/FOREIGN KEY/);
      });

      expect(await storage.roles.findByIds(["role-x"])).toEqual([]);
      expect(await storage.organizations.findById("org-2")).not.toBeNull();
    });

    it("un role que falla a medias fuera de una transacción tampoco deja nada (a diferencia de un autocommit por sentencia)", async () => {
      const storage = createSqliteStorage(db);
      await storage.organizations.create({ id: "org-1", name: "Acme" });

      await expect(
        storage.roles.create({ id: "role-x", organizationId: "org-1", name: "X", permissionKeys: ["not.registered"] }),
      ).rejects.toThrow(/FOREIGN KEY/);

      expect(await storage.roles.findByIds(["role-x"])).toEqual([]);
    });

    it("dos storages construidos sobre la misma conexión comparten la cola: uno no se cuela en la transacción del otro", async () => {
      const first = createSqliteStorage(db);
      const second = createSqliteStorage(db);

      const failing = first.transaction(async (tx) => {
        await tx.organizations.create({ id: "org-inside", name: "Inside" });
        await sleep(30);
        throw new Error("boom");
      });
      await sleep(5);
      const outside = second.organizations.create({ id: "org-outside", name: "Outside" });

      await expect(failing).rejects.toThrow("boom");
      await expect(outside).resolves.toMatchObject({ id: "org-outside" });
      expect(await first.organizations.findById("org-inside")).toBeNull();
      expect(await first.organizations.findById("org-outside")).not.toBeNull();
    });

    it("muchas operaciones concurrentes sobre la misma conexión no se mezclan ni se pierden", async () => {
      const storage = createSqliteStorage(db);

      await Promise.all(
        Array.from({ length: 60 }, (_, index) =>
          index % 3 === 0
            ? storage.transaction(async (tx) => {
                await tx.organizations.create({ id: `org-${index}`, name: `Org ${index}` });
                await sleep(1);
              })
            : storage.organizations.create({ id: `org-${index}`, name: `Org ${index}` }),
        ),
      );

      await expect(storage.organizations.count()).resolves.toBe(60);
    });
  });

  describe("guardas de segunda capa (mismo patrón SQL que usan los repositorios)", () => {
    it("el insert de membership_roles dentro de create() nunca acepta un role.id que ya no pertenece a la organización (misma guarda que assignRole)", async () => {
      // Ver la versión de @uniora/postgres: ejercita directamente el `insert ...
      // where exists (...)` correlacionado que cierra la ventana ABA entre la
      // validación por lote de `roleIds` y el insert real (Ronda 8).
      const storage = createSqliteStorage(db);
      const orgA = await storage.organizations.create({ id: "org-a", name: "Org A" });
      const orgB = await storage.organizations.create({ id: "org-b", name: "Org B" });
      const roleId = "role-shared-id-2";
      await storage.roles.create({ id: roleId, organizationId: orgA.id, name: "Sales" });
      await storage.memberships.create({ id: "m-2", organizationId: orgA.id, identity: { provider: "supabase", subject: "member-2" } });

      await storage.roles.delete(roleId);
      await storage.roles.create({ id: roleId, organizationId: orgB.id, name: "Sales (recreado en Org B)" });

      const result = db
        .prepare(
          `insert into uniora_membership_roles (membership_id, role_id)
           select ?1, ?2
           where exists (select 1 from uniora_roles r where r.id = ?2 and r.organization_id = ?3)
           on conflict do nothing`,
        )
        .run({ 1: "m-2", 2: roleId, 3: orgA.id });

      expect(result.changes).toBe(0);
      expect(db.prepare("select 1 from uniora_membership_roles where membership_id = 'm-2'").get()).toBeUndefined();
    });

    it("el último Owner no se puede quitar ni borrando el membership ni desasignando el rol, aunque se pida a la vez", async () => {
      const storage = createSqliteStorage(db);
      const { membership } = await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme",
        ownerRoleId: "role-owner",
        membershipId: "m-owner",
        ownerIdentity: identity,
      });

      const results = await Promise.allSettled([
        storage.memberships.delete(membership.id),
        storage.memberships.unassignOwnerRole(membership.id, "role-owner"),
        storage.memberships.delete(membership.id),
      ]);

      expect(results.every((result) => result.status === "rejected")).toBe(true);
      for (const result of results) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(MembershipError);
      }
      expect(await storage.memberships.findById(membership.id)).not.toBeNull();
    });
  });
});
