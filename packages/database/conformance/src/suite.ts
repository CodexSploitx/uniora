import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAuditedStorage,
  createAuthorizationEngine,
  createInvitationService,
  InvitationError,
  createOrganizationWithOwner,
  FeatureError,
  IdentityLinkError,
  MembershipError,
  OrganizationError,
  PermissionError,
  RoleError,
  leaveOrganization,
  transferOwnership,
} from "@uniora/core";
import type { StorageHarness } from "./harness.js";

const identity = { provider: "supabase", subject: "user-1" };

/**
 * The behaviour every `UnioraStorage` adapter must reproduce, row for row.
 * Extracted from `@uniora/postgres`'s own integration suite so a second
 * adapter is held to the SAME assertions — including the concurrency and
 * security regressions (docs/security-pentest-2026-09-24.md) — instead of
 * a re-written, possibly weaker copy. Real database, never mocks.
 *
 * Adapter-specific behaviour (SQL dialect details, driver error codes) goes
 * in `adapterSpecificTests`; the migration ledger stays in the adapter's own
 * test file.
 */
export function defineStorageConformance(harness: StorageHarness, adapterSpecificTests?: () => void): void {
  describe(`${harness.name} — UnioraStorage conformance`, () => {
    beforeAll(() => harness.setup());
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    // Same database lifecycle (and truncation between tests) as the shared
    // tests: an adapter's dialect-specific checks run here instead of in a
    // second `describe`, which would race the shared one for the same tables.
    adapterSpecificTests?.();

    it("persists organizations, deriving a slug from the name", async () => {
      const storage = harness.storage();

      const created = await storage.organizations.create({ id: "org-1", name: "Acme del Oeste" });
      expect(created).toMatchObject({ name: "Acme del Oeste", slug: "acme-del-oeste" });

      const found = await storage.organizations.findById("org-1");
      expect(found?.slug).toBe("acme-del-oeste");

      expect(await storage.organizations.list()).toHaveLength(1);
    });

    it("renombra una organización sin tocar su slug, sanitiza el nombre y devuelve null si no existe", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      const renamed = await storage.organizations.rename("org-1", "  Acme   Global ");
      expect(renamed).toMatchObject({ id: "org-1", name: "Acme Global", slug: "acme-motors" });
      expect((await storage.organizations.findById("org-1"))?.name).toBe("Acme Global");

      await expect(storage.organizations.rename("org-1", "   ")).rejects.toThrow(OrganizationError);
      expect(await storage.organizations.rename("missing", "Nope")).toBeNull();
    });

    it("rechaza un slug duplicado (constraint real) y distingue el mensaje de un id duplicado", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      await expect(
        storage.organizations.create({ id: "org-2", name: "Something Else", slug: "acme-motors" }),
      ).rejects.toThrow(/slug "acme-motors" already exists/);

      await expect(
        storage.organizations.create({ id: "org-1", name: "Yet Another Name" }),
      ).rejects.toThrow(/id "org-1" already exists/);
    });

    it("rechaza un nombre vacío y un slug explícito mal formado (sanitización compartida con @uniora/core)", async () => {
      const storage = harness.storage();
      await expect(storage.organizations.create({ id: "org-1", name: "   " })).rejects.toThrow(OrganizationError);
      await expect(
        storage.organizations.create({ id: "org-1", name: "Acme Motors", slug: "Not A Slug" }),
      ).rejects.toThrow(OrganizationError);
    });

    it("createOrganizationWithOwner acepta un organizationSlug explícito", async () => {
      const storage = harness.storage();
      const { organization } = await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors",
        organizationSlug: "acme",
        ownerRoleId: "role-owner",
        membershipId: "m-1",
        ownerIdentity: identity,
      });

      expect(organization.slug).toBe("acme");
    });

    it("stores role permissions and membership roles across the join tables", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.permissions.register({ key: "vehicles.create" });
      await storage.roles.create({ id: "role-admin", organizationId: "org-1", name: "Admin", permissionKeys: ["vehicles.create"] });
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      await storage.memberships.assignRole(membership.id, "role-admin");

      const found = await storage.memberships.findByIdentity("org-1", identity);
      expect(found?.roleIds).toEqual(["role-admin"]);

      const [role] = await storage.roles.findByIds(["role-admin"]);
      expect(role?.permissionKeys).toEqual(["vehicles.create"]);
    });

    it("register() de un Permission acepta name/description y es un upsert idempotente", async () => {
      const storage = harness.storage();

      const permission = await storage.permissions.register({ key: "vehicles.delete", name: "Delete Vehicles" });
      expect(permission).toMatchObject({ key: "vehicles.delete", name: "Delete Vehicles" });

      await storage.permissions.register({ key: "vehicles.delete", name: "Delete Vehicles v2", description: "..." });

      const found = await storage.permissions.findByKey("vehicles.delete");
      expect(found).toEqual({ key: "vehicles.delete", name: "Delete Vehicles v2", description: "..." });
    });

    it("rechaza un Permission key mal formado (constraint real vía check, no solo de aplicación)", async () => {
      const storage = harness.storage();

      await expect(storage.permissions.register({ key: "delete" })).rejects.toThrow(PermissionError);
      await expect(storage.permissions.register({ key: "Vehicles.Delete" })).rejects.toThrow(PermissionError);
    });

    it("rechaza crear dos roles con el mismo nombre en la misma organización (constraint real, no solo de aplicación)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.roles.create({ id: "role-sales-1", organizationId: "org-1", name: "Sales" });

      await expect(storage.roles.create({ id: "role-sales-2", organizationId: "org-1", name: "Sales" })).rejects.toThrow(
        RoleError,
      );
    });

    it("deriva un key único por role a partir del nombre (estándar de creación, constraint real)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      const role = await storage.roles.create({ id: "role-billing", organizationId: "org-1", name: "Billing Manager" });

      expect(role.key).toBe("billing-manager");
    });

    it("rechaza dos roles cuyo key colisiona, aunque el nombre difiera (constraint real distinta de la de nombre)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.roles.create({ id: "role-1", organizationId: "org-1", name: "Billing", key: "billing" });

      await expect(
        storage.roles.create({ id: "role-2", organizationId: "org-1", name: "Facturación", key: "billing" }),
      ).rejects.toThrow(RoleError);
    });

    it('rechaza el key reservado "owner" para un role custom', async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      await expect(
        storage.roles.create({ id: "role-fake-owner", organizationId: "org-1", name: "Founder", key: "owner" }),
      ).rejects.toThrow(RoleError);
    });

    it("renombrar un role custom nunca cambia su key", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });

      const renamed = await storage.roles.rename(role.id, "Sales Team");

      expect(renamed.key).toBe(role.key);
      expect(renamed.key).toBe("sales");
    });

    it("create() no deja un role huérfano en la base si permissionKeys es inválido (hallazgo de /ultrareview)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      await expect(
        storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales", permissionKeys: [""] }),
      ).rejects.toThrow(RoleError);

      // Antes del fix, el insert del role corría (y hacía autocommit,
      // fuera de storage.transaction) antes de validar permissionKeys —
      // dejando este role creado sin permisos pese al error.
      expect(await storage.roles.findByIds(["role-sales"])).toEqual([]);
    });

    it("renombra y borra roles custom, y el borrado desasigna el rol de sus memberships (cascade real)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      await storage.memberships.assignRole(membership.id, role.id);

      const renamed = await storage.roles.rename(role.id, "Sales Team");
      expect(renamed.name).toBe("Sales Team");

      await storage.roles.delete(role.id);

      expect(await storage.roles.findByIds([role.id])).toEqual([]);
      const found = await storage.memberships.findByIdentity("org-1", identity);
      expect(found?.roleIds).toEqual([]);
    });

    it("createOrganizationWithOwner crea la org, su Owner role protegido y la membership fundadora en una sola transacción real", async () => {
      const storage = harness.storage();

      const { organization, ownerRole, membership } = await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors",
        ownerRoleId: "role-owner",
        membershipId: "m-1",
        ownerIdentity: identity,
      });

      expect(organization.name).toBe("Acme Motors");
      expect(ownerRole).toMatchObject({ isOwnerRole: true, key: "owner", name: "Owner" });
      expect(membership.roleIds).toEqual([ownerRole.id]);

      const engine = createAuthorizationEngine(storage);
      expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
    });

    it("rechaza un segundo Owner role para la misma organización (constraint real de base de datos)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.roles.createOwnerRole({ id: "role-owner-1", organizationId: "org-1" });

      await expect(storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-1" })).rejects.toThrow(
        RoleError,
      );
    });

    it("createOrganizationWithOwner hace rollback real: un id de organización duplicado no deja un Owner role o membership huérfanos", async () => {
      const storage = harness.storage();
      await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors",
        ownerRoleId: "role-owner-1",
        membershipId: "m-1",
        ownerIdentity: identity,
      });

      // Mismo organizationId: `tx.organizations.create` falla por PK duplicada
      // a mitad de la transacción — Postgres debe revertir también el
      // `createOwnerRole`/`memberships.create` que ya se habían ejecutado
      // antes en la misma transacción.
      await expect(
        createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Should not persist",
          ownerRoleId: "role-owner-2",
          membershipId: "m-2",
          ownerIdentity: { provider: "supabase", subject: "user-2" },
        }),
      ).rejects.toThrow();

      const org = await storage.organizations.findById("org-1");
      expect(org?.name).toBe("Acme Motors");
      expect(await storage.roles.findByIds(["role-owner-2"])).toEqual([]);
      expect(await storage.memberships.findByIdentity("org-1", { provider: "supabase", subject: "user-2" })).toBeNull();
    });

    it("rechaza renombrar, borrar, otorgar o revocar permisos del Owner role protegido", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.permissions.register({ key: "vehicles.delete" });
      const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });

      await expect(storage.roles.rename(owner.id, "Not Owner")).rejects.toThrow(RoleError);
      await expect(storage.roles.grantPermission(owner.id, "vehicles.delete")).rejects.toThrow(RoleError);
      await expect(storage.roles.revokePermission(owner.id, "vehicles.delete")).rejects.toThrow(RoleError);
      await expect(storage.roles.delete(owner.id)).rejects.toThrow(RoleError);

      const [stillOwner] = await storage.roles.findByIds([owner.id]);
      expect(stillOwner).toMatchObject({ isOwnerRole: true, key: "owner", name: "Owner", permissionKeys: [] });
    });

    it("rechaza unassignRole/delete del único membership con el Owner role (constraint atómico real)", async () => {
      const storage = harness.storage();
      const { ownerRole, membership } = await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors",
        ownerRoleId: "role-owner",
        membershipId: "m-1",
        ownerIdentity: identity,
      });

      await expect(storage.memberships.unassignOwnerRole(membership.id, ownerRole.id)).rejects.toThrow(MembershipError);
      await expect(storage.memberships.delete(membership.id)).rejects.toThrow(MembershipError);

      // Nada debe haber cambiado.
      const found = await storage.memberships.findByIdentity("org-1", identity);
      expect(found?.roleIds).toEqual([ownerRole.id]);
    });

    it("permite unassignRole/delete del Owner role cuando otro membership también lo tiene", async () => {
      const storage = harness.storage();
      const { ownerRole, membership } = await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors",
        ownerRoleId: "role-owner",
        membershipId: "m-1",
        ownerIdentity: identity,
      });
      const secondIdentity = { provider: "supabase", subject: "user-2" };
      await storage.memberships.create({
        id: "m-2",
        organizationId: "org-1",
        identity: secondIdentity,
        roleIds: [ownerRole.id],
      });

      await expect(storage.memberships.unassignOwnerRole(membership.id, ownerRole.id)).resolves.toBeUndefined();
      const found = await storage.memberships.findByIdentity("org-1", identity);
      expect(found?.roleIds).toEqual([]);

      // El segundo owner sigue siendo el único — borrarlo ahora sí debe fallar.
      await expect(storage.memberships.delete("m-2")).rejects.toThrow(MembershipError);
    });

    it("unassignRole de un role no asignado es idempotente; delete de un membership inexistente falla", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

      await expect(storage.memberships.unassignRole(membership.id, "no-such-role")).resolves.toBeUndefined();
      await storage.memberships.delete(membership.id);
      await expect(storage.memberships.delete(membership.id)).rejects.toThrow(MembershipError);
    });

    it("rechaza create()/assignRole() con un roleId de otra organización (regresión — docs/security-pentest-2026-09-24.md Hallazgo 2)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Org" });
      const roleOrg2 = await storage.roles.create({ id: "role-org-2", organizationId: "org-2", name: "Admin" });

      await expect(
        storage.memberships.create({ id: "m-forged", organizationId: "org-1", identity, roleIds: [roleOrg2.id] }),
      ).rejects.toThrow(MembershipError);
      expect(await storage.memberships.findById("m-forged")).toBeNull();

      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      await expect(storage.memberships.assignRole(membership.id, roleOrg2.id)).rejects.toThrow(MembershipError);
      expect((await storage.memberships.findById(membership.id))?.roleIds).toEqual([]);

      // El mismo role SÍ se asigna normalmente dentro de su propia organización.
      const roleOrg1 = await storage.roles.create({ id: "role-org-1", organizationId: "org-1", name: "Sales" });
      await expect(storage.memberships.assignRole(membership.id, roleOrg1.id)).resolves.toBeUndefined();
      expect((await storage.memberships.findById(membership.id))?.roleIds).toEqual([roleOrg1.id]);
    });

    it("toggles features per organization", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      expect(await storage.features.isEnabled("org-1", "advanced_inventory")).toBe(false);

      await storage.features.register({ key: "advanced_inventory", name: "Advanced Inventory" });
      await storage.features.enable("org-1", "advanced_inventory");
      expect(await storage.features.isEnabled("org-1", "advanced_inventory")).toBe(true);

      await storage.features.disable("org-1", "advanced_inventory");
      expect(await storage.features.isEnabled("org-1", "advanced_inventory")).toBe(false);
    });

    it("rechaza enable()/disable() de un feature key nunca registrado (constraint real, no solo de aplicación)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });

      await expect(storage.features.enable("org-1", "never_registered")).rejects.toThrow(FeatureError);
      await expect(storage.features.disable("org-1", "never_registered")).rejects.toThrow(FeatureError);
    });

    it("no confunde el FK de organization_id con el de key al fallar enable() (hallazgo de /ultrareview)", async () => {
      const storage = harness.storage();
      await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });

      // features tiene dos claves foráneas (organización y definición) — un
      // organizationId inválido también viola una, pero no significa
      // "feature no registrado".
      await expect(storage.features.enable("org-does-not-exist", "advanced_reports")).rejects.not.toBeInstanceOf(
        FeatureError,
      );
    });

    it("register() deriva el key del nombre y es un upsert idempotente (constraint real, no solo de aplicación)", async () => {
      const storage = harness.storage();

      const definition = await storage.features.register({ name: "Advanced Reports" });
      expect(definition).toMatchObject({ key: "advanced_reports", name: "Advanced Reports" });

      await storage.features.register({ key: "advanced_reports", name: "Advanced Reports v2", description: "..." });

      const catalog = await storage.features.listCatalog();
      expect(catalog).toContainEqual({ key: "advanced_reports", name: "Advanced Reports v2", description: "...", defaultEnabled: false });
    });

    describe("features — valor por defecto, jerarquía, operaciones masivas y metadatos", () => {
      const operator = { provider: "supabase", subject: "operator" };

      async function seedOrganizations(storage: ReturnType<StorageHarness["storage"]>, ids = ["org-1", "org-2", "org-3"]) {
        for (const id of ids) await storage.organizations.create({ id, name: `Org ${id}` });
      }

      it("una función con defaultEnabled nace activa sin filas; un override explícito gana en los dos sentidos", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage);
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        await storage.features.register({ key: "reports", name: "Reports" });

        expect(await storage.features.isEnabled("org-1", "agenda")).toBe(true);
        expect(await storage.features.isEnabled("org-1", "reports")).toBe(false);
        expect(await storage.features.enabledKeys("org-1", ["agenda", "reports", "ghost"])).toEqual(["agenda"]);
        expect(await storage.features.listByOrganization("org-1")).toEqual([]);

        await storage.features.disable("org-1", "agenda");
        await storage.features.enable("org-1", "reports");
        expect(await storage.features.isEnabled("org-1", "agenda")).toBe(false);
        expect(await storage.features.isEnabled("org-2", "agenda")).toBe(true);
        expect(await storage.features.isEnabled("org-1", "reports")).toBe(true);

        expect((await storage.features.listCatalog()).find((f) => f.key === "agenda")).toMatchObject({ defaultEnabled: true });
        // Registrar de nuevo sin defaultEnabled lo resetea (upsert completo).
        await storage.features.register({ key: "agenda", name: "Agenda" });
        expect((await storage.features.listCatalog()).find((f) => f.key === "agenda")).toMatchObject({ defaultEnabled: false });
      });

      it("access.check y los snapshots respetan el valor por defecto", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage, ["org-1"]);
        const owner = await storage.roles.createOwnerRole({ id: "r", organizationId: "org-1" });
        const membership = await storage.memberships.create({ id: "m", organizationId: "org-1", identity });
        await storage.memberships.assignOwnerRole(membership.id, owner.id);
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        const engine = createAuthorizationEngine(storage);

        expect(await engine.access.check({ identity, organizationId: "org-1", feature: "agenda" })).toBe(true);
        await storage.features.disable("org-1", "agenda");
        expect(await engine.access.check({ identity, organizationId: "org-1", feature: "agenda" })).toBe(false);
      });

      it("jerarquía: apagar el padre apaga a los hijos; listEffective explica el motivo", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage, ["org-1", "org-2"]);
        await storage.features.register({ key: "workspace", name: "Workspace", defaultEnabled: true });
        await storage.features.register({ key: "workspace_chat", name: "Chat", defaultEnabled: true, parentKey: "workspace" });
        await storage.features.register({ key: "workspace_files", name: "Files", parentKey: "workspace" });
        await storage.features.enable("org-1", "workspace_files");

        await storage.features.disable("org-1", "workspace", { actor: operator, reason: "impago" });

        expect(await storage.features.isEnabled("org-1", "workspace_chat")).toBe(false);
        expect(await storage.features.isEnabled("org-1", "workspace_files")).toBe(false);
        expect(await storage.features.isEnabled("org-2", "workspace_chat")).toBe(true);
        const byKey = Object.fromEntries((await storage.features.listEffective("org-1")).map((f) => [f.key, f]));
        expect(byKey.workspace_chat).toMatchObject({ enabled: false, reason: "parent_disabled", blockedBy: "workspace", parentKey: "workspace" });
        expect(byKey.workspace_files).toMatchObject({ enabled: false, reason: "parent_disabled" });
        expect(byKey.workspace).toMatchObject({ enabled: false, reason: "disabled", override: { enabled: false, reason: "impago", updatedBy: operator } });
        expect((await storage.features.listEffective("org-2")).map((f) => [f.key, f.reason])).toEqual([
          ["workspace", "default"],
          ["workspace_chat", "default"],
          ["workspace_files", "default"],
        ]);

        // El uso agregado y los filtros cuentan el estado EFECTIVO.
        expect(await storage.features.countEnabledByOrganization(["org-1", "org-2"])).toEqual({ "org-1": 0, "org-2": 2 });
        expect(await storage.features.summarizeUsage(["workspace_chat", "workspace_files", "workspace", "ghost"], 5)).toEqual({
          workspace: { enabledCount: 1, sampleOrganizationIds: ["org-2"] },
          workspace_chat: { enabledCount: 1, sampleOrganizationIds: ["org-2"] },
          workspace_files: { enabledCount: 0, sampleOrganizationIds: [] },
          ghost: { enabledCount: 0, sampleOrganizationIds: [] },
        });
        expect((await storage.features.search({ enabledIn: "org-2" })).map((f) => f.key)).toEqual(["workspace", "workspace_chat"]);
        expect(await storage.features.count({ enabledIn: "org-1" })).toBe(0);
        expect(await storage.features.summarizeUsage(["workspace"], 0)).toEqual({ workspace: { enabledCount: 1, sampleOrganizationIds: [] } });
      });

      it("rechaza padres desconocidos, a sí mismo, ciclos; y no deja desregistrar un padre con hijos", async () => {
        const storage = harness.storage();
        await storage.features.register({ key: "root", name: "Root" });
        await storage.features.register({ key: "child", name: "Child", parentKey: "root" });

        await expect(storage.features.register({ key: "orphan", name: "O", parentKey: "ghost" })).rejects.toMatchObject({ code: "feature_parent_invalid" });
        await expect(storage.features.register({ key: "root", name: "R", parentKey: "root" })).rejects.toMatchObject({ code: "feature_parent_invalid" });
        await expect(storage.features.register({ key: "root", name: "R", parentKey: "child" })).rejects.toMatchObject({ code: "feature_parent_invalid" });
        await expect(storage.features.unregister("root")).rejects.toMatchObject({ code: "feature_has_children" });
        await storage.features.unregister("child");
        await storage.features.unregister("root");
      });

      it("setMany aplica todo o nada y registra quién, cuándo y por qué", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage, ["org-1"]);
        await storage.features.register({ key: "a", name: "A" });
        await storage.features.register({ key: "b", name: "B", defaultEnabled: true });

        await expect(storage.features.setMany("org-1", { a: true, ghost: true })).rejects.toMatchObject({ code: "feature_unknown" });
        expect(await storage.features.isEnabled("org-1", "a")).toBe(false);
        expect(await storage.features.listByOrganization("org-1")).toEqual([]);

        const before = Date.now() - 1000;
        await storage.features.setMany("org-1", { a: true, b: false }, { actor: operator, reason: "  plan Pro  " });
        expect(await storage.features.isEnabled("org-1", "a")).toBe(true);
        expect(await storage.features.isEnabled("org-1", "b")).toBe(false);
        const rows = await storage.features.listByOrganization("org-1");
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row).toMatchObject({ updatedBy: operator, reason: "plan Pro" });
          expect(row.updatedAt!.getTime()).toBeGreaterThanOrEqual(before);
        }
        // Sin metadatos: el cambio igual queda fechado, pero sin autor ni motivo.
        await storage.features.enable("org-1", "b");
        const plain = (await storage.features.listByOrganization("org-1")).find((f) => f.key === "b")!;
        expect(plain.updatedAt).toBeInstanceOf(Date);
        expect(plain.updatedBy).toBeUndefined();
        expect(plain.reason).toBeUndefined();
        await storage.features.setMany("org-1", {});
      });

      it("setMany dentro de una transacción que falla no deja nada (atomicidad real)", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage, ["org-1"]);
        await storage.features.register({ key: "a", name: "A" });
        await expect(
          storage.transaction(async (tx) => {
            await tx.features.setMany("org-1", { a: true });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await storage.features.isEnabled("org-1", "a")).toBe(false);
      });

      it("disableEverywhere apaga la función en todas las organizaciones, también donde no había fila, y permite desregistrarla", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage, ["org-1", "org-2"]);
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        await storage.features.enable("org-1", "agenda");
        await expect(storage.features.unregister("agenda")).rejects.toMatchObject({ code: "feature_in_use" });

        expect(await storage.features.disableEverywhere("agenda", { actor: operator, reason: "incidente" })).toEqual({
          disabledOverrides: 1,
          defaultWasEnabled: true,
        });
        expect(await storage.features.isEnabled("org-1", "agenda")).toBe(false);
        expect(await storage.features.isEnabled("org-2", "agenda")).toBe(false);
        expect((await storage.features.listByOrganization("org-1"))[0]).toMatchObject({ enabled: false, reason: "incidente", updatedBy: operator });
        await expect(storage.features.disableEverywhere("ghost")).rejects.toMatchObject({ code: "feature_unknown" });
        await storage.features.unregister("agenda");
      });

      it("una función activa por defecto no se desregistra mientras alguna organización la tenga efectivamente activa", async () => {
        const storage = harness.storage();
        await seedOrganizations(storage, ["org-1"]);
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        await expect(storage.features.unregister("agenda")).rejects.toMatchObject({ code: "feature_in_use" });
        await storage.features.disable("org-1", "agenda");
        // Todas las organizaciones existentes la tienen apagada → se puede desregistrar.
        await storage.features.unregister("agenda");
      });
    });

    describe("memberships — estado (bloqueo), fechas y autoría", () => {
      const admin = { provider: "supabase", subject: "admin" };
      const alice = { provider: "supabase", subject: "alice" };
      const bob = { provider: "supabase", subject: "bob" };

      async function seed() {
        const storage = harness.storage();
        await storage.organizations.create({ id: "org-1", name: "Acme" });
        await storage.permissions.register({ key: "reports.read" });
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        const owner = await storage.roles.createOwnerRole({ id: "owner", organizationId: "org-1" });
        const staff = await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["reports.read"] });
        const a = await storage.memberships.create({ id: "m-alice", organizationId: "org-1", identity: alice, roleIds: [staff.id], invitedBy: admin });
        const b = await storage.memberships.create({ id: "m-bob", organizationId: "org-1", identity: bob });
        await storage.memberships.assignOwnerRole(b.id, owner.id);
        return { storage, owner, staff, a, b };
      }

      it("nace activa, con createdAt/updatedAt y quién invitó, y lo conserva al leerla", async () => {
        const { storage, a, b } = await seed();
        expect(a).toMatchObject({ status: "active", invitedBy: admin });
        expect(a.createdAt).toBeInstanceOf(Date);
        expect(b.invitedBy).toBeUndefined();
        const found = (await storage.memberships.findById("m-alice"))!;
        expect(found).toMatchObject({ status: "active", invitedBy: admin, roleIds: ["staff"] });
        expect(found.createdAt.getTime()).toBe(a.createdAt.getTime());
        expect(found.lastActiveAt).toBeUndefined();
        expect(found.blocked).toBeUndefined();
        expect((await storage.memberships.findByIdentity("org-1", alice))!.id).toBe("m-alice");
        expect((await storage.memberships.listByOrganization("org-1")).every((m) => m.status === "active")).toBe(true);
      });

      it("asignar y quitar roles actualiza updatedAt y no createdAt", async () => {
        const { storage, a } = await seed();
        await storage.roles.create({ id: "other", organizationId: "org-1", name: "Other" });
        await new Promise((resolve) => setTimeout(resolve, 15));
        await storage.memberships.assignRole("m-alice", "other");
        const afterAssign = (await storage.memberships.findById("m-alice"))!;
        expect(afterAssign.createdAt.getTime()).toBe(a.createdAt.getTime());
        expect(afterAssign.updatedAt.getTime()).toBeGreaterThan(a.createdAt.getTime());
        await new Promise((resolve) => setTimeout(resolve, 15));
        await storage.memberships.unassignRole("m-alice", "other");
        expect((await storage.memberships.findById("m-alice"))!.updatedAt.getTime()).toBeGreaterThan(afterAssign.updatedAt.getTime());
      });

      it("bloquear no elimina: conserva roles pero el motor lo deniega todo; desbloquear lo restaura", async () => {
        const { storage, a } = await seed();
        const engine = createAuthorizationEngine(storage);
        const input = { identity: alice, organizationId: "org-1", permission: "reports.read" };
        expect(await engine.can(input)).toBe(true);
        expect(await engine.access.check({ ...input, feature: "agenda" })).toBe(true);

        const blocked = await storage.memberships.block(a.id, { actor: admin, reason: "  impago  " });
        expect(blocked).toMatchObject({ status: "blocked", roleIds: ["staff"], blocked: { by: admin, reason: "impago" } });
        expect(blocked.blocked!.at).toBeInstanceOf(Date);
        expect(await engine.can(input)).toBe(false);
        expect(await engine.access.check({ ...input, feature: "agenda" })).toBe(false);
        expect(await engine.access.check({ identity: alice, organizationId: "org-1" })).toBe(false);
        expect(await engine.access.check({ identity: alice, organizationId: "org-1", feature: "agenda" })).toBe(false);
        expect(await engine.can({ identity: bob, organizationId: "org-1", permission: "reports.read" })).toBe(true);
        // El bloqueo se ve al volver a leer, también por identidad enlazada.
        expect((await storage.memberships.findByIdentity("org-1", alice))!.blocked).toMatchObject({ by: admin, reason: "impago" });

        const unblocked = await storage.memberships.unblock(a.id, { actor: admin });
        expect(unblocked.status).toBe("active");
        expect(unblocked.blocked).toBeUndefined();
        expect(await engine.can(input)).toBe(true);
      });

      it("bloquear y desbloquear son idempotentes; el primer bloqueo conserva autor y motivo; ids desconocidos fallan con código", async () => {
        const { storage, a } = await seed();
        await storage.memberships.block(a.id, { actor: admin, reason: "uno" });
        expect((await storage.memberships.block(a.id, { actor: bob, reason: "dos" })).blocked).toMatchObject({ by: admin, reason: "uno" });
        await storage.memberships.unblock(a.id, { actor: admin });
        expect((await storage.memberships.unblock(a.id, { actor: admin })).status).toBe("active");
        await expect(storage.memberships.block("nope", { actor: admin })).rejects.toMatchObject({ code: "membership_not_found" });
        await expect(storage.memberships.unblock("nope", { actor: admin })).rejects.toMatchObject({ code: "membership_not_found" });
      });

      it("no se puede bloquear al último Owner activo, pero sí a uno de dos", async () => {
        const { storage, owner, a, b } = await seed();
        await expect(storage.memberships.block(b.id, { actor: admin })).rejects.toMatchObject({ code: "last_owner" });
        expect((await storage.memberships.findById(b.id))!.status).toBe("active");

        await storage.memberships.assignOwnerRole(a.id, owner.id);
        await storage.memberships.block(b.id, { actor: admin });
        await expect(storage.memberships.block(a.id, { actor: admin })).rejects.toMatchObject({ code: "last_owner" });
      });

      it("filtra y cuenta por estado, y el listado trae estado, fecha, invitedBy y lastActiveAt", async () => {
        const { storage, a } = await seed();
        await storage.memberships.block(a.id, { actor: admin });
        expect((await storage.memberships.search({ organizationId: "org-1", status: "blocked" })).map((m) => m.id)).toEqual(["m-alice"]);
        expect(await storage.memberships.count({ organizationId: "org-1", status: "active" })).toBe(1);
        expect(await storage.memberships.count({ organizationId: "org-1" })).toBe(2);
        const seen = new Date(Date.now() + 60_000);
        await storage.memberships.recordActivity(a.id, seen);
        const listing = await storage.memberships.searchListing({ organizationId: "org-1", rolesPerMember: 2, status: "blocked" });
        expect(listing).toMatchObject([{ id: "m-alice", status: "blocked", invitedBy: admin, roleCount: 1 }]);
        expect(listing[0]!.createdAt).toBeInstanceOf(Date);
        expect(listing[0]!.lastActiveAt!.getTime()).toBe(seen.getTime());
      });

      it("recordActivity solo avanza lastActiveAt, no toca updatedAt y no falla con un id desconocido", async () => {
        const { storage, a } = await seed();
        const before = (await storage.memberships.findById(a.id))!;
        const later = new Date(Date.now() + 60_000);
        await storage.memberships.recordActivity(a.id, later);
        await storage.memberships.recordActivity(a.id, new Date(later.getTime() - 30_000));
        await storage.memberships.recordActivity("nope");
        const found = (await storage.memberships.findById(a.id))!;
        expect(found.lastActiveAt!.getTime()).toBe(later.getTime());
        expect(found.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      });

      it("dos Owners que se bloquean a la vez nunca dejan la organización sin un Owner activo", async () => {
        for (let trial = 0; trial < 4; trial++) {
          await harness.reset();
          const { storage, owner, a, b } = await seed();
          await storage.memberships.assignOwnerRole(a.id, owner.id);
          const outcomes = await Promise.allSettled([
            storage.memberships.block(a.id, { actor: admin }),
            storage.memberships.block(b.id, { actor: admin }),
          ]);
          expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
          expect(await storage.memberships.count({ organizationId: "org-1", status: "active" })).toBe(1);
        }
      });
    });

    describe("audit log — search por acción, actor, objetivo y rango; actor obligatorio", () => {
      const ana = { provider: "supabase", subject: "ana" };
      const luis = { provider: "supabase", subject: "luis" };

      async function seedLog() {
        const storage = harness.storage();
        await storage.organizations.create({ id: "org-1", name: "Uno" });
        await storage.organizations.create({ id: "org-2", name: "Dos" });
        const rows: Array<[string, string | undefined, typeof ana, string, { type: string; id: string } | undefined]> = [
          ["a1", "org-1", ana, "membership.blocked", { type: "membership", id: "m-1" }],
          ["a2", "org-1", luis, "membership.unblocked", { type: "membership", id: "m-1" }],
          ["a3", "org-1", ana, "feature.disabled", { type: "feature", id: "agenda" }],
          ["a4", "org-2", ana, "membership.blocked", { type: "membership", id: "m-9" }],
          ["a5", undefined, luis, "identity_link.created", undefined],
        ];
        for (const [id, organizationId, actor, action, target] of rows) {
          await storage.auditLogs.record({ id, organizationId, actor, action, target });
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        return storage;
      }
      const ids = (entries: Array<{ id: string }>) => entries.map((entry) => entry.id);
      const sameActor = (a: { provider: string; subject: string }, b: { provider: string; subject: string }) =>
        a.provider === b.provider && a.subject === b.subject;

      it("filtra por organización, acción exacta o varias, prefijo, actor y objetivo; siempre más reciente primero", async () => {
        const storage = await seedLog();
        const logs = storage.auditLogs;
        expect(ids(await logs.search())).toEqual(["a5", "a4", "a3", "a2", "a1"]);
        expect(ids(await logs.search({ organizationId: "org-1" }))).toEqual(["a3", "a2", "a1"]);
        expect(ids(await logs.search({ action: "membership.blocked" }))).toEqual(["a4", "a1"]);
        expect(ids(await logs.search({ action: ["feature.disabled", "identity_link.created"] }))).toEqual(["a5", "a3"]);
        expect(ids(await logs.search({ actionPrefix: "membership." }))).toEqual(["a4", "a2", "a1"]);
        expect(ids(await logs.search({ actionPrefix: "membership.", organizationId: "org-1", actor: ana }))).toEqual(["a1"]);
        expect(ids(await logs.search({ target: { type: "membership", id: "m-1" } }))).toEqual(["a2", "a1"]);
        expect(ids(await logs.search({ target: { type: "membership" } }))).toEqual(["a4", "a2", "a1"]);
        expect(ids(await logs.search({ actor: luis }))).toEqual(["a5", "a2"]);
        // Un % o _ en el prefijo es texto, no un comodín.
        expect(await logs.search({ actionPrefix: "%" })).toEqual([]);
        expect(await logs.search({ actionPrefix: "membership_" })).toEqual([]);
      });

      it("filtra por rango de tiempo y pagina con cursor sin huecos ni repeticiones", async () => {
        const storage = await seedLog();
        const all = await storage.auditLogs.search();
        const third = all[2]!;
        expect(ids(await storage.auditLogs.search({ since: third.createdAt }))).toEqual(["a5", "a4", "a3"]);
        expect(ids(await storage.auditLogs.search({ until: third.createdAt }))).toEqual(["a2", "a1"]);

        const seen: string[] = [];
        let before: { createdAt: Date; id: string } | undefined;
        for (let page = 0; page < 5; page++) {
          const entries = await storage.auditLogs.search({ limit: 2, before });
          if (entries.length === 0) break;
          seen.push(...ids(entries));
          before = { createdAt: entries[entries.length - 1]!.createdAt, id: entries[entries.length - 1]!.id };
        }
        expect(seen).toEqual(["a5", "a4", "a3", "a2", "a1"]);
      });

      it("createAuditedStorage: el cambio y su entrada de auditoría se confirman o se revierten juntos", async () => {
        const raw = harness.storage();
        const audited = createAuditedStorage(raw, { actor: ana });
        await expect(
          audited.transaction(async (tx) => {
            await tx.organizations.create({ id: "org-x", name: "Equis" });
            await tx.features.register({ key: "agenda", name: "Agenda" });
            await tx.features.setMany("org-x", { agenda: true }, { actor: ana, reason: "plan" });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await raw.organizations.findById("org-x")).toBeNull();
        expect(await raw.auditLogs.search()).toEqual([]);

        await audited.organizations.create({ id: "org-y", name: "Ye" });
        await audited.memberships.create({ id: "m-y", organizationId: "org-y", identity: luis });
        const written = await raw.auditLogs.search({ organizationId: "org-y" });
        expect(written.map((e) => e.action).sort()).toEqual(["membership.created", "organization.created"]);
        expect(written.every((e) => sameActor(e.actor, ana))).toBe(true);
      });

      it("rechaza una entrada sin actor o sin acción, y no escribe nada", async () => {
        const storage = harness.storage();
        for (const bad of [
          { id: "x1", actor: { provider: "", subject: "s" }, action: "role.created" },
          { id: "x2", actor: { provider: "p", subject: "  " }, action: "role.created" },
          { id: "x3", actor: undefined as unknown as typeof ana, action: "role.created" },
        ]) {
          await expect(storage.auditLogs.record(bad)).rejects.toMatchObject({ code: "audit_actor_required" });
        }
        await expect(storage.auditLogs.record({ id: "x4", actor: ana, action: " " })).rejects.toMatchObject({ code: "audit_action_invalid" });
        expect(await storage.auditLogs.search()).toEqual([]);
      });
    });

    it("permission.unregister() rechaza un key nunca registrado, y uno todavía otorgado a algún role", async () => {
      const storage = harness.storage();
      await expect(storage.permissions.unregister("vehicles.delete")).rejects.toThrow(PermissionError);

      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.permissions.register({ key: "vehicles.delete" });
      await storage.roles.create({
        id: "role-admin",
        organizationId: "org-1",
        name: "Admin",
        permissionKeys: ["vehicles.delete"],
      });

      await expect(storage.permissions.unregister("vehicles.delete")).rejects.toThrow(PermissionError);
      expect(await storage.permissions.findByKey("vehicles.delete")).not.toBeNull();
    });

    it("permission.unregister() elimina el catálogo (constraint real, no solo de aplicación) una vez revocado de todo role", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.permissions.register({ key: "vehicles.delete" });
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

    it("feature.unregister() rechaza un key nunca registrado, y uno todavía habilitado en alguna organización", async () => {
      const storage = harness.storage();
      await expect(storage.features.unregister("advanced_reports")).rejects.toThrow(FeatureError);

      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
      await storage.features.enable("org-1", "advanced_reports");

      await expect(storage.features.unregister("advanced_reports")).rejects.toThrow(FeatureError);
      expect(await storage.features.listCatalog()).toContainEqual(
        expect.objectContaining({ key: "advanced_reports" }),
      );
    });

    it("feature.unregister() elimina el catálogo y cascadea sobre los toggles deshabilitados (constraint real)", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
      await storage.features.enable("org-1", "advanced_reports");
      await storage.features.disable("org-1", "advanced_reports");

      await storage.features.unregister("advanced_reports");

      expect(await storage.features.listCatalog()).toEqual([]);
      expect(await storage.features.listByOrganization("org-1")).toEqual([]);
    });

    it("rolls back every write when the transaction callback throws", async () => {
      const storage = harness.storage();

      await expect(
        storage.transaction(async (tx) => {
          await tx.organizations.create({ id: "org-rollback", name: "Should not persist" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await storage.organizations.findById("org-rollback")).toBeNull();
    });

    it("drives the same authorization engine used by @uniora/core against real data", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Org" });
      await storage.permissions.register({ key: "vehicles.create" });
      await storage.permissions.register({ key: "vehicles.delete" });
      await storage.roles.create({ id: "role-other-org", organizationId: "org-2", name: "Admin", permissionKeys: ["vehicles.create"] });
      await storage.roles.create({ id: "role-admin", organizationId: "org-1", name: "Admin", permissionKeys: ["vehicles.delete"] });
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
      // `MembershipRepository.create`/`assignRole` both reject a cross-org
      // roleId at the source (docs/security-pentest-2026-09-24.md Hallazgo 2)
      // — so this can no longer be produced through the public API. Insert the
      // forged/corrupted row directly to prove the Engine's own defense-in-depth
      // still holds regardless of how such a row came to exist.
      await harness.probe.forgeMembershipRole(membership.id, "role-other-org");
      await storage.memberships.assignRole(membership.id, "role-admin");

      const engine = createAuthorizationEngine(storage);

      expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.create" })).toBe(false);
      expect(await engine.can({ identity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);

      expect(
        await engine.access.check({ identity, organizationId: "org-1", permission: "vehicles.delete", feature: "advanced_inventory" }),
      ).toBe(false);

      await storage.features.register({ key: "advanced_inventory", name: "Advanced Inventory" });
      await storage.features.enable("org-1", "advanced_inventory");

      expect(
        await engine.access.check({ identity, organizationId: "org-1", permission: "vehicles.delete", feature: "advanced_inventory" }),
      ).toBe(true);
    });

    it("access.check({ feature }) sin permission exige membership real (regresión — docs/security-pentest-2026-09-24.md Hallazgo 4)", async () => {
      const storage = harness.storage();
      const engine = createAuthorizationEngine(storage);
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });
      await storage.features.enable("org-1", "ai_assistant");
      const ownerOfOrg2 = { provider: "supabase", subject: "owner-2" };
      await createOrganizationWithOwner(storage, {
        organizationId: "org-2",
        organizationName: "Other Org With Owner",
        ownerRoleId: "role-owner-2",
        membershipId: "membership-owner-2",
        ownerIdentity: ownerOfOrg2,
      });
      const outsider = { provider: "attacker-controlled", subject: "nobody" };

      expect(await storage.features.isEnabled("org-1", "ai_assistant")).toBe(true);
      // Ninguna de las dos identidades tiene membership en org-1 — el feature
      // habilitado ahí no debe concederles acceso.
      expect(await engine.access.check({ identity: outsider, organizationId: "org-1", feature: "ai_assistant" })).toBe(false);
      expect(await engine.access.check({ identity: ownerOfOrg2, organizationId: "org-1", feature: "ai_assistant" })).toBe(false);

      await storage.memberships.create({ id: "m-real", organizationId: "org-1", identity });
      expect(await engine.access.check({ identity, organizationId: "org-1", feature: "ai_assistant" })).toBe(true);
    });

    it("registra y lista entradas de audit log, aisladas por organización", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Org" });

      await storage.auditLogs.record({
        id: "log-1",
        organizationId: "org-1",
        actor: identity,
        action: "role.created",
        target: { type: "role", id: "role-admin" },
        metadata: { name: "Admin" },
      });
      await storage.auditLogs.record({
        id: "log-2",
        organizationId: "org-2",
        actor: identity,
        action: "role.created",
      });

      const org1Logs = await storage.auditLogs.listByOrganization("org-1");
      expect(org1Logs).toHaveLength(1);
      expect(org1Logs[0]).toMatchObject({
        id: "log-1",
        organizationId: "org-1",
        actor: identity,
        action: "role.created",
        target: { type: "role", id: "role-admin" },
        metadata: { name: "Admin" },
      });
      expect(org1Logs[0]?.createdAt).toBeInstanceOf(Date);

      const org2Logs = await storage.auditLogs.listByOrganization("org-2");
      expect(org2Logs.map((entry) => entry.id)).toEqual(["log-2"]);
    });

    it("no expone ningún método para modificar o borrar una entrada de audit log ya registrada", async () => {
      const storage = harness.storage();
      const keys = Object.keys(storage.auditLogs);

      expect(keys).toEqual(expect.arrayContaining(["record", "listByOrganization", "listRecent"]));
      expect(keys).not.toContain("update");
      expect(keys).not.toContain("delete");
    });

    it("encadena las entradas con hash y verifyIntegrity() las valida, incluso con escrituras concurrentes (audit F-04)", async () => {
      const storage = harness.storage();
      await Promise.all(
        Array.from({ length: 15 }, (_, n) =>
          storage.auditLogs.record({ id: `chain-${n}`, actor: identity, action: "role.created", metadata: { n } }),
        ),
      );
      const report = await storage.auditLogs.verifyIntegrity();
      expect(report).toMatchObject({ ok: true, checked: 15 });
      expect(report.head?.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("verifyIntegrity() de un log vacío es válido", async () => {
      expect(await harness.storage().auditLogs.verifyIntegrity()).toMatchObject({ ok: true, checked: 0 });
    });

    it("la base rechaza UPDATE y DELETE directos sobre el audit log (audit F-04)", async () => {
      const storage = harness.storage();
      await storage.auditLogs.record({ id: "log-x", actor: identity, action: "role.created" });
      expect(await harness.probe.attemptAuditUpdate("log-x")).toBe("rejected");
      expect(await harness.probe.attemptAuditDelete("log-x")).toBe("rejected");
      expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: true, checked: 1 });
    });

    it("detecta una entrada editada o borrada por alguien con privilegios para saltarse la protección", async () => {
      const storage = harness.storage();
      for (const id of ["a", "b", "c", "d"]) await storage.auditLogs.record({ id, actor: identity, action: "role.created" });

      await harness.probe.tamperAuditAction("b", "role.deleted");
      expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({
        ok: false,
        checked: 1,
        broken: { id: "b", reason: "content_mismatch" },
      });
    });

    it("detecta una entrada borrada del medio del log", async () => {
      const storage = harness.storage();
      for (const id of ["a", "b", "c", "d"]) await storage.auditLogs.record({ id, actor: identity, action: "role.created" });

      await harness.probe.tamperAuditDelete("b");
      expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({
        ok: false,
        broken: { id: "c", reason: "chain_broken" },
      });
    });

    it("el ancla externa detecta el truncado del final del log (audit F-04)", async () => {
      const storage = harness.storage();
      for (const id of ["a", "b", "c", "d"]) await storage.auditLogs.record({ id, actor: identity, action: "role.created" });
      const { head } = await storage.auditLogs.verifyIntegrity();
      expect(head).toBeDefined();

      expect(await storage.auditLogs.verifyIntegrity({ anchor: head! })).toMatchObject({ ok: true, anchor: "valid" });
      expect(await storage.auditLogs.verifyIntegrity({ anchor: { ...head!, hash: "0".repeat(64) } })).toMatchObject({
        ok: false,
        anchor: "mismatch",
      });

      await harness.probe.tamperAuditDelete("d");
      expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: true });
      expect(await storage.auditLogs.verifyIntegrity({ anchor: head! })).toMatchObject({ ok: false, anchor: "missing" });
    });

    describe("audit log — retención con checkpoint de la cadena", () => {
      const pause = () => new Promise((resolve) => setTimeout(resolve, 8));

      /** `old` entries, a cut-off, then `recent` entries: the cut-off falls cleanly between them. */
      async function seedAround(old: string[], recent: string[]) {
        const storage = harness.storage();
        for (const id of old) await storage.auditLogs.record({ id, actor: identity, action: "role.created" });
        await pause();
        const cutoff = new Date();
        await pause();
        for (const id of recent) await storage.auditLogs.record({ id, actor: identity, action: "role.updated" });
        return { storage, cutoff };
      }
      const ids = (entries: Array<{ id: string }>) => entries.map((entry) => entry.id);

      it("quita lo anterior al corte, conserva lo demás, deja la cadena verificable y se audita", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2", "o3"], ["n1", "n2"]);
        const before = await storage.auditLogs.verifyIntegrity();
        expect(before).toMatchObject({ ok: true, checked: 5 });
        expect(before.pruned).toBeUndefined();

        const result = await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });
        expect(result.removed).toBe(3);
        expect(result.through?.hash).toMatch(/^[0-9a-f]{64}$/);

        const remaining = ids(await storage.auditLogs.search());
        expect(remaining).toHaveLength(3);
        expect(remaining).toEqual(expect.arrayContaining(["n1", "n2"]));
        expect(remaining).not.toContain("o1");

        const pruned = await storage.auditLogs.search({ action: "audit_log.pruned" });
        expect(pruned).toHaveLength(1);
        expect(pruned[0]).toMatchObject({ actor: identity, metadata: { removed: 3, throughPosition: result.through?.position } });

        const after = await storage.auditLogs.verifyIntegrity();
        expect(after).toMatchObject({ ok: true, checked: 3, pruned: { removed: 3, through: result.through } });
        // Positions are stable: the head moved on by exactly the one `audit_log.pruned` entry.
        expect(after.head?.position).toBe((before.head?.position ?? 0) + 1);
      });

      it("nunca quita la entrada más reciente aunque todo sea anterior al corte", async () => {
        const { storage } = await seedAround(["o1", "o2", "o3"], []);
        await pause();
        const result = await storage.auditLogs.pruneBefore({ before: new Date(), actor: identity });
        expect(result.removed).toBe(2);
        expect(ids(await storage.auditLogs.search({ action: "role.created" }))).toEqual(["o3"]);
        expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: true, checked: 2 });
      });

      it("es idempotente: sin nada más viejo no quita nada ni escribe otra entrada", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1"]);
        await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });
        const again = await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });
        expect(again).toEqual({ removed: 0 });
        expect(await harness.probe.countAuditEntries("audit_log.pruned")).toBe(1);
      });

      it("un log vacío no tiene nada que podar", async () => {
        const result = await harness.storage().auditLogs.pruneBefore({ before: new Date(), actor: identity });
        expect(result).toEqual({ removed: 0 });
      });

      it("rechaza un corte en el futuro o inválido", async () => {
        const { storage } = await seedAround(["o1", "o2"], []);
        await expect(
          storage.auditLogs.pruneBefore({ before: new Date(Date.now() + 86_400_000), actor: identity }),
        ).rejects.toMatchObject({ code: "audit_prune_invalid" });
        await expect(storage.auditLogs.pruneBefore({ before: new Date("nope"), actor: identity })).rejects.toMatchObject({
          code: "audit_prune_invalid",
        });
        expect(await storage.auditLogs.search()).toHaveLength(2);
      });

      it("sigue detectando lo editado o borrado DESPUÉS del checkpoint", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1", "n2", "n3"]);
        await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });

        await harness.probe.tamperAuditAction("n2", "role.deleted");
        expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({
          ok: false,
          broken: { id: "n2", reason: "content_mismatch" },
          pruned: { removed: 2 },
        });
      });

      it("detecta una entrada borrada del medio tras podar", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1", "n2", "n3"]);
        await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });

        await harness.probe.tamperAuditDelete("n2");
        expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: false, broken: { id: "n3", reason: "chain_broken" } });
      });

      it("la base sigue rechazando UPDATE y DELETE directos después de podar", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1"]);
        await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });
        expect(await harness.probe.attemptAuditUpdate("n1")).toBe("rejected");
        expect(await harness.probe.attemptAuditDelete("n1")).toBe("rejected");
        expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: true });
      });

      it("un ancla anterior al checkpoint se informa como 'pruned' sin marcar manipulación; la posterior sigue validándose", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1", "n2"]);
        const { head } = await storage.auditLogs.verifyIntegrity();
        await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });

        // The anchored head is the newest entry at the time: it was kept, at the same position.
        expect(await storage.auditLogs.verifyIntegrity({ anchor: head! })).toMatchObject({ ok: true, anchor: "valid" });
        expect(await storage.auditLogs.verifyIntegrity({ anchor: { position: 1, hash: "0".repeat(64) } })).toMatchObject({
          ok: true,
          anchor: "pruned",
        });
        expect(await storage.auditLogs.verifyIntegrity({ anchor: { ...head!, hash: "0".repeat(64) } })).toMatchObject({
          ok: false,
          anchor: "mismatch",
        });
      });

      it("acumula: una segunda poda suma al total quitado y mueve el checkpoint", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1"]);
        const first = await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });
        await pause();
        const second = await storage.auditLogs.pruneBefore({ before: new Date(), actor: identity });
        expect(second.removed).toBeGreaterThan(0);
        expect(second.through?.position ?? 0).toBeGreaterThan(first.through?.position ?? 0);
        const report = await storage.auditLogs.verifyIntegrity();
        expect(report).toMatchObject({ ok: true, pruned: { removed: first.removed + second.removed } });
        expect(report.pruned?.through).toEqual(second.through);
      });

      it("escrituras nuevas después de podar se encadenan con normalidad", async () => {
        const { storage, cutoff } = await seedAround(["o1", "o2"], ["n1"]);
        await storage.auditLogs.pruneBefore({ before: cutoff, actor: identity });
        await Promise.all(
          Array.from({ length: 6 }, (_, n) => storage.auditLogs.record({ id: `late-${n}`, actor: identity, action: "role.created" })),
        );
        expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: true, checked: 8 });
      });
    });

    it("listRecent mezcla entradas de todas las organizaciones y pagina con keyset (`before`), no offset", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Other Org" });

      await storage.auditLogs.record({ id: "log-a", organizationId: "org-1", actor: identity, action: "role.created" });
      await storage.auditLogs.record({ id: "log-b", organizationId: "org-2", actor: identity, action: "role.created" });
      await storage.auditLogs.record({ id: "log-c", organizationId: "org-1", actor: identity, action: "role.created" });
      await storage.auditLogs.record({ id: "log-d", organizationId: "org-2", actor: identity, action: "role.created" });

      const firstPage = await storage.auditLogs.listRecent({ limit: 2 });
      expect(firstPage).toHaveLength(2);
      expect(firstPage[0]?.createdAt).toBeInstanceOf(Date);

      const cursor = firstPage[firstPage.length - 1];
      if (!cursor) throw new Error("expected a first page");
      const secondPage = await storage.auditLogs.listRecent({ limit: 2, before: { createdAt: cursor.createdAt, id: cursor.id } });

      // Every id across both pages, exactly once — no gaps, no repeats.
      const allIds = [...firstPage, ...secondPage].map((entry) => entry.id).sort();
      expect(allIds).toEqual(["log-a", "log-b", "log-c", "log-d"].sort());
      expect(new Set([...firstPage.map((e) => e.id), ...secondPage.map((e) => e.id)]).size).toBe(4);
    });

    it("organizations.search filtra por name/slug (case-insensitive) y organizations.count refleja el mismo filtro", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.organizations.create({ id: "org-2", name: "Sunrise Labs", slug: "sunrise" });
      await storage.organizations.create({ id: "org-3", name: "Northwind" });

      await expect(storage.organizations.search({ query: "acme" })).resolves.toMatchObject([{ id: "org-1" }]);
      await expect(storage.organizations.search({ query: "SUN" })).resolves.toMatchObject([{ id: "org-2" }]);
      await expect(storage.organizations.search({ query: "nope" })).resolves.toEqual([]);

      await expect(storage.organizations.count()).resolves.toBe(3);
      await expect(storage.organizations.count({ query: "acme" })).resolves.toBe(1);
      await expect(storage.organizations.count({ query: "nope" })).resolves.toBe(0);
    });

    it("organizations.search pagina con keyset (`after`), no offset, sin huecos ni repeticiones", async () => {
      const storage = harness.storage();
      for (let i = 0; i < 12; i++) {
        await storage.organizations.create({ id: `org-scale-${i}`, name: `Scale Org ${i}` });
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
    });

    it("permissions.search filtra por key/name (case-insensitive, comodines escapados) y pagina con keyset sin huecos", async () => {
      const storage = harness.storage();
      await storage.permissions.register({ key: "vehicles.delete", name: "Delete vehicles" });
      await storage.permissions.register({ key: "leads.read", name: "View leads" });
      for (let i = 0; i < 12; i++) {
        await storage.permissions.register({ key: `bulk${String(i).padStart(2, "0")}.read` });
      }

      await expect(storage.permissions.search({ query: "VEHICLES" })).resolves.toMatchObject([{ key: "vehicles.delete" }]);
      await expect(storage.permissions.search({ query: "view" })).resolves.toMatchObject([{ key: "leads.read" }]);
      // `_` y `%` se tratan como texto literal, no como comodines de ilike.
      await expect(storage.permissions.search({ query: "_" })).resolves.toMatchObject([]);
      await expect(storage.permissions.search({ query: "%" })).resolves.toEqual([]);
      await expect(storage.permissions.count()).resolves.toBe(14);
      await expect(storage.permissions.count({ query: "bulk" })).resolves.toBe(12);

      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 4; page++) {
        const results = await storage.permissions.search({ limit: 5, after });
        seen.push(...results.map((p) => p.key));
        const last = results.at(-1);
        if (!last) break;
        after = last.key;
      }
      expect(seen).toHaveLength(14);
      expect(new Set(seen).size).toBe(14);
    });

    it("permissions.countRoleGrants cuenta roles por key entre organizaciones, con 0 para los no otorgados", async () => {
      const storage = harness.storage();
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
      await expect(storage.permissions.countRoleGrants([])).resolves.toEqual({});
    });

    it("features.search/count filtran y paginan por keyset, y summarizeUsage cuenta + muestrea organizaciones en una sola consulta", async () => {
      const storage = harness.storage();
      await storage.features.register({ name: "Advanced reports", key: "advanced_reports", description: "Reports" });
      await storage.features.register({ name: "AI assistant" });
      for (let i = 0; i < 10; i++) await storage.features.register({ name: `Bulk ${String(i).padStart(2, "0")}` });

      await expect(storage.features.search({ query: "REPORTS" })).resolves.toMatchObject([{ key: "advanced_reports" }]);
      await expect(storage.features.search({ query: "nope" })).resolves.toEqual([]);
      await expect(storage.features.count()).resolves.toBe(12);
      await expect(storage.features.count({ query: "bulk" })).resolves.toBe(10);

      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 4; page++) {
        const results = await storage.features.search({ limit: 5, after });
        seen.push(...results.map((f) => f.key));
        const last = results.at(-1);
        if (!last) break;
        after = last.key;
      }
      expect(new Set(seen).size).toBe(12);
      expect(seen).toHaveLength(12);

      for (const id of ["o1", "o2", "o3", "o4"]) await storage.organizations.create({ id, name: `Org ${id}` });
      for (const id of ["o1", "o2", "o3"]) await storage.features.enable(id, "advanced_reports");
      await storage.features.disable("o4", "advanced_reports");
      await storage.features.enable("o1", "ai_assistant");

      await expect(storage.features.summarizeUsage(["advanced_reports", "ai_assistant", "bulk_00"], 2)).resolves.toEqual({
        advanced_reports: { enabledCount: 3, sampleOrganizationIds: ["o1", "o2"] },
        ai_assistant: { enabledCount: 1, sampleOrganizationIds: ["o1"] },
        bulk_00: { enabledCount: 0, sampleOrganizationIds: [] },
      });
      await expect(storage.features.summarizeUsage([], 3)).resolves.toEqual({});
    });

    it("organizations.findByIds devuelve solo los ids existentes", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "o1", name: "Acme" });
      await storage.organizations.create({ id: "o2", name: "Beta" });

      const found = await storage.organizations.findByIds(["o1", "o2", "ghost"]);
      expect(found.map((o) => o.id).sort()).toEqual(["o1", "o2"]);
      await expect(storage.organizations.findByIds([])).resolves.toEqual([]);
    });

    it("count/countByOrganization de memberships, roles y features habilitadas: una consulta por lote, 0 para ids sin filas", async () => {
      const storage = harness.storage();
      await storage.features.register({ name: "Reports", key: "reports" });
      await storage.features.register({ name: "AI", key: "ai" });
      for (const id of ["o1", "o2", "o3"]) await storage.organizations.create({ id, name: `Org ${id}` });
      await storage.roles.create({ id: "r1", organizationId: "o1", name: "A" });
      await storage.roles.create({ id: "r2", organizationId: "o1", name: "B" });
      await storage.roles.create({ id: "r3", organizationId: "o2", name: "C" });
      await storage.memberships.create({ id: "m1", organizationId: "o1", identity: { provider: "supabase", subject: "u1" } });
      await storage.memberships.create({ id: "m2", organizationId: "o1", identity: { provider: "supabase", subject: "u2" } });
      await storage.memberships.create({ id: "m3", organizationId: "o2", identity: { provider: "supabase", subject: "u3" } });
      await storage.features.enable("o1", "reports");
      await storage.features.enable("o1", "ai");
      await storage.features.enable("o2", "reports");
      await storage.features.disable("o2", "ai");

      const ids = ["o1", "o2", "o3", "ghost"];
      await expect(storage.memberships.countByOrganization(ids)).resolves.toEqual({ o1: 2, o2: 1, o3: 0, ghost: 0 });
      await expect(storage.roles.countByOrganization(ids)).resolves.toEqual({ o1: 2, o2: 1, o3: 0, ghost: 0 });
      await expect(storage.features.countEnabledByOrganization(ids)).resolves.toEqual({ o1: 2, o2: 1, o3: 0, ghost: 0 });
      await expect(storage.memberships.count()).resolves.toBe(3);
      await expect(storage.roles.count()).resolves.toBe(3);
      await expect(storage.roles.countByOrganization([])).resolves.toEqual({});
    });

    it("vistas de detalle de una organización: búsqueda paginada de miembros/roles, permisos por rol, features habilitadas y auditoría keyset", async () => {
      const storage = harness.storage();

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

    it("miembros con muchos roles: listado con vista previa acotada + total, y filtros heldBy/notHeldBy", async () => {
      const storage = harness.storage();

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

    it("ficha de un miembro: identidad en varias organizaciones, permisos efectivos vía roles y roles que los conceden", async () => {
      const storage = harness.storage();

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

    it("Ronda 4 Hallazgo 8 (TOCTOU, CRITICAL): dos Owners no pueden demoverse mutuamente y dejar la organización sin ninguno", async () => {
      const storage = harness.storage();
      const { organization, ownerRole, membership: owner1 } = await createOrganizationWithOwner(storage, {
        organizationId: "org-toctou",
        organizationName: "TOCTOU Corp",
        ownerRoleId: "role-owner-toctou",
        membershipId: "m-owner1-toctou",
        ownerIdentity: { provider: "e2e", subject: "owner1-toctou" },
      });
      const owner2 = await storage.memberships.create({
        id: "m-owner2-toctou",
        organizationId: organization.id,
        identity: { provider: "e2e", subject: "owner2-toctou" },
      });
      await storage.memberships.assignOwnerRole(owner2.id, ownerRole.id);
      await expect(storage.memberships.countByRole([ownerRole.id])).resolves.toEqual({ [ownerRole.id]: 2 });

      // Sin `await` entre las dos llamadas: maximiza la superposición real de
      // las dos conexiones de red hacia Postgres, reproduciendo la carrera
      // (antes del fix: 4/5 corridas dejaban la organización sin owners).
      const results = await Promise.allSettled([
        storage.memberships.unassignOwnerRole(owner1.id, ownerRole.id),
        storage.memberships.unassignOwnerRole(owner2.id, ownerRole.id),
      ]);

      const remaining = (await storage.memberships.countByRole([ownerRole.id]))[ownerRole.id];
      expect(remaining).toBeGreaterThanOrEqual(1);
      // Exactamente una de las dos debe haber sido rechazada — nunca "las dos
      // tuvieron éxito" (eso es precisamente el bug que dejaba 0 owners).
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.length).toBeGreaterThanOrEqual(1);
    });

    it("Ronda 4 Hallazgo 8 (TOCTOU): misma race vía delete() de membership, no solo unassignOwnerRole()", async () => {
      const storage = harness.storage();
      const { organization, ownerRole, membership: owner1 } = await createOrganizationWithOwner(storage, {
        organizationId: "org-toctou-del",
        organizationName: "TOCTOU Del Corp",
        ownerRoleId: "role-owner-toctou-del",
        membershipId: "m-owner1-toctou-del",
        ownerIdentity: { provider: "e2e", subject: "owner1-toctou-del" },
      });
      const owner2 = await storage.memberships.create({
        id: "m-owner2-toctou-del",
        organizationId: organization.id,
        identity: { provider: "e2e", subject: "owner2-toctou-del" },
      });
      await storage.memberships.assignOwnerRole(owner2.id, ownerRole.id);

      const results = await Promise.allSettled([storage.memberships.delete(owner1.id), storage.memberships.delete(owner2.id)]);

      const remaining = (await storage.memberships.countByRole([ownerRole.id]))[ownerRole.id];
      expect(remaining).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThanOrEqual(1);
    });

    it("Ronda 4 Hallazgo 9 (TOCTOU): identityLinks.link() no permite crear una cadena de 2 saltos vía condición de carrera", async () => {
      const storage = harness.storage();
      const A = { provider: "chain-toctou", subject: "A" };
      const B = { provider: "chain-toctou", subject: "B" };
      const C = { provider: "chain-toctou", subject: "C" };

      // Sin `await` entre ambas: A->B y B->C compiten por la identidad
      // compartida B (B es el `to` de la primera y el `from` de la segunda).
      // Antes del fix: 20/20 corridas creaban la cadena completa.
      const results = await Promise.allSettled([
        storage.identityLinks.link({ from: A, to: B, actor: B }),
        storage.identityLinks.link({ from: B, to: C, actor: C }),
      ]);

      const bothSucceeded = results.every((r) => r.status === "fulfilled");
      expect(bothSucceeded).toBe(false);

      // Verificación directa del invariante "no chains": nunca debe existir
      // simultáneamente un link cuyo `to` es B y otro cuyo `from` es B.
      const resolvedFromA = await storage.identityLinks.resolve(A);
      const resolvedFromB = await storage.identityLinks.resolve(B);
      const aWasLinked = resolvedFromA.provider === B.provider && resolvedFromA.subject === B.subject;
      const bWasLinked = resolvedFromB.provider === C.provider && resolvedFromB.subject === C.subject;
      expect(aWasLinked && bWasLinked).toBe(false);
    }, 15000);

    it("Ronda 6 (adapter parity, encontrado por fuzzing): rechaza un segundo membership para la misma identidad en la misma organización, igual que memoria tras su fix", async () => {
      const storage = harness.storage();
      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

      await expect(storage.memberships.create({ id: "m-2-duplicate", organizationId: "org-1", identity })).rejects.toThrow(MembershipError);

      // Control: la misma identidad SÍ puede tener un membership en otra organización.
      await storage.organizations.create({ id: "org-2", name: "Beta" });
      await expect(storage.memberships.create({ id: "m-org2", organizationId: "org-2", identity })).resolves.toMatchObject({ organizationId: "org-2" });
    });

    it("resuelve una identidad migrada al mismo membership, sin re-otorgar permisos", async () => {
      const storage = harness.storage();
      const oldIdentity = { provider: "supabase", subject: "user-1" };
      const newIdentity = { provider: "clerk", subject: "user-1-clerk" };

      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.permissions.register({ key: "vehicles.delete" });
      await storage.roles.create({
        id: "role-admin",
        organizationId: "org-1",
        name: "Admin",
        permissionKeys: ["vehicles.delete"],
      });
      const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity: oldIdentity });
      await storage.memberships.assignRole(membership.id, "role-admin");

      const engine = createAuthorizationEngine(storage);
      expect(await engine.can({ identity: newIdentity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(false);

      await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });

      const found = await storage.memberships.findByIdentity("org-1", newIdentity);
      expect(found?.id).toBe(membership.id);
      expect(await engine.can({ identity: newIdentity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(true);
    });

    it("rechaza el link si 'from' ya tiene su propia membership (anti-secuestro)", async () => {
      const storage = harness.storage();
      const oldIdentity = { provider: "supabase", subject: "user-1" };
      const attackerIdentity = { provider: "clerk", subject: "attacker" };

      await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
      await storage.memberships.create({ id: "m-attacker", organizationId: "org-1", identity: attackerIdentity });

      await expect(
        storage.identityLinks.link({ from: attackerIdentity, to: oldIdentity, actor: oldIdentity }),
      ).rejects.toThrow(IdentityLinkError);
    });

    it("es idempotente y rechaza relinkear a un target distinto o encadenar", async () => {
      const storage = harness.storage();
      const oldIdentity = { provider: "supabase", subject: "user-1" };
      const newIdentity = { provider: "clerk", subject: "user-1-clerk" };
      const otherIdentity = { provider: "auth0", subject: "user-1-auth0" };

      const link = await storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity });
      await expect(
        storage.identityLinks.link({ from: newIdentity, to: oldIdentity, actor: oldIdentity }),
      ).resolves.toMatchObject({ from: link.from, to: link.to });

      await expect(
        storage.identityLinks.link({ from: newIdentity, to: otherIdentity, actor: oldIdentity }),
      ).rejects.toThrow(IdentityLinkError);

      await expect(
        storage.identityLinks.link({ from: otherIdentity, to: newIdentity, actor: oldIdentity }),
      ).rejects.toThrow(IdentityLinkError);
    });

    describe("MembershipRepository.create() — boundary collapse vía identity link inverso (regresión, docs/security-pentest-2026-09-24.md Ronda 7)", () => {
      const actor = { provider: "supabase", subject: "actor-owner" };

        it("rechaza secuencialmente crear un membership directo para una identidad que ya es 'from' de un link", async () => {
          const storage = harness.storage();
          const y = { provider: "legacy", subject: "y" };
          const x = { provider: "new-provider", subject: "x" };
          await storage.organizations.create({ id: "org-1", name: "Acme" });
          await storage.memberships.create({ id: "m-y", organizationId: "org-1", identity: y });
          await storage.identityLinks.link({ from: x, to: y, actor });

          // Antes del fix: nada impedía esto, produciendo el estado "ambiguous/
          // hijackable lookup" que link() ya rechaza en la dirección opuesta —
          // Memory y Postgres resolvían la ambigüedad resultante de forma
          // DISTINTA (Memory siempre favorecía el link; Postgres, la fila
          // directa), confirmando también una divergencia real entre adapters.
          await expect(
            storage.memberships.create({ id: "m-x", organizationId: "org-1", identity: x, roleIds: [] }),
          ).rejects.toThrow(MembershipError);
        });

        it("una identidad no linkeada crea su membership directo normalmente (no es una regresión general)", async () => {
          const storage = harness.storage();
          const x = { provider: "new-provider", subject: "x" };
          await storage.organizations.create({ id: "org-1", name: "Acme" });
          await expect(
            storage.memberships.create({ id: "m-x", organizationId: "org-1", identity: x, roleIds: [] }),
          ).resolves.toMatchObject({ organizationId: "org-1" });
        });

        it("bajo concurrencia real, link() y create() para la misma identidad nunca tienen éxito ambos (TOCTOU cerrado)", async () => {
          // Antes del fix, esta carrera dejaba el estado ambiguo en 25/25
          // intentos: `create()` nunca leía `identity_links`, así que el SERIALIZABLE
          // que envuelve `link()` (Hallazgo 9, Ronda 4) no tenía el ciclo de
          // dependencia read-write que necesita para detectar el conflicto —
          // solo protegía a link() contra otros link(), nunca contra create().
          const storage = harness.storage();
          const y = { provider: "legacy", subject: "y" };
          const x = { provider: "new-provider", subject: "x" };
          await storage.organizations.create({ id: "org-1", name: "Acme" });
          await storage.memberships.create({ id: "m-y", organizationId: "org-1", identity: y });

          const [linkResult, createResult] = await Promise.allSettled([
            storage.identityLinks.link({ from: x, to: y, actor }),
            storage.memberships.create({ id: "m-x", organizationId: "org-1", identity: x, roleIds: [] }),
          ]);

          const bothSucceeded = linkResult.status === "fulfilled" && createResult.status === "fulfilled";
          expect(bothSucceeded).toBe(false);
        });
    });

    describe("Ronda 8 (docs/security-pentest-2026-09-24.md) — ABA de role y auditoría fantasma de identity link", () => {
      const actor = { provider: "supabase", subject: "actor-owner" };

        it("assignRole() nunca inserta membership_roles para un role.id reciclado en otra organización (ABA)", async () => {
          // Antes del fix, `assignRole()` capturaba `role.organization_id` en un
          // SELECT separado y lo reutilizaba en el INSERT posterior — si el role
          // se borraba y se recreaba con el MISMO id en OTRA organización entre
          // esos dos statements (`roles.id` es una PK global, no por-organización,
          // así que esto es alcanzable vía la API pública), el INSERT usaba el
          // valor obsoleto y creaba una fila cross-org. Reproducido aquí
          // simulando la ventana directamente contra Postgres real; confirma que
          // el `where exists (...)` correlacionado del fix la cierra.
          const storage = harness.storage();
          const orgA = await storage.organizations.create({ id: "org-a", name: "Org A" });
          const orgB = await storage.organizations.create({ id: "org-b", name: "Org B" });
          const roleId = "role-shared-id";
          await storage.roles.create({ id: roleId, organizationId: orgA.id, name: "Sales" });
          const member = await storage.memberships.create({ id: "m-1", organizationId: orgA.id, identity: { provider: "supabase", subject: "member" } });

          await storage.roles.delete(roleId);
          await storage.roles.create({ id: roleId, organizationId: orgB.id, name: "Sales (recreado en Org B)" });

          // assignRole() ahora re-lee organization_id FRESCO, correlacionado con
          // el INSERT — con el role ya en Org B, debe rechazar (o al menos nunca
          // insertar la fila) para un membership de Org A.
          await expect(storage.memberships.assignRole(member.id, roleId)).rejects.toThrow(MembershipError);
          expect(await harness.probe.hasMembershipRole(member.id, roleId)).toBe(false);
        });

        it("link() bajo serialization failure nunca deja una entrada de audit log para un link que no se persistió", async () => {
          // Antes del fix, `auditLogs.record()` dentro de `performLink()` usaba
          // un `AuditLogRepository` ligado al `Pool` de nivel superior (no al
          // `client` de la transacción SERIALIZABLE del intento actual) — un
          // intento que fallaba al hacer COMMIT (40001) hacía rollback del
          // insert en `identity_links`, pero la entrada de audit log, ya
          // comiteada de forma independiente vía una conexión aparte, sobrevivía. Reproducido
          // 5/5 veces con este escenario exacto antes del fix; ahora debe quedar
          // como máximo una entrada de audit log por cada link REALMENTE
          // persistido.
          const storage = harness.storage();
          const org = await storage.organizations.create({ id: "org-1", name: "Acme" });
          const A = { provider: "legacy", subject: "chain-a" };
          const B = { provider: "legacy", subject: "chain-b" };
          const C = { provider: "legacy", subject: "chain-c" };
          await storage.memberships.create({ id: "m-a", organizationId: org.id, identity: A });

          const [r1, r2] = await Promise.allSettled([
            storage.identityLinks.link({ from: B, to: A, actor }),
            storage.identityLinks.link({ from: C, to: B, actor }),
          ]);
          const succeededCount = [r1, r2].filter((r) => r.status === "fulfilled").length;

          expect(await harness.probe.countIdentityLinks()).toBe(succeededCount);

          expect(await harness.probe.countAuditEntries("identity_link.created")).toBe(succeededCount);
        });
    });

    describe("identity links — unlink (audit F-12)", () => {
      const actor = { provider: "supabase", subject: "operator" };
      const from = { provider: "clerk", subject: "user_new" };
      const to = { provider: "supabase", subject: "user-old" };

      it("unlink() quita el enlace, deja de resolver, audita y es idempotente", async () => {
        const storage = harness.storage();
        await storage.identityLinks.link({ from, to, actor });
        expect(await storage.identityLinks.resolve(from)).toEqual(to);

        expect(await storage.identityLinks.unlink({ from, actor })).toBe(true);
        expect(await storage.identityLinks.resolve(from)).toEqual(from);
        expect(await harness.probe.countIdentityLinks()).toBe(0);
        expect(await harness.probe.countAuditEntries("identity_link.removed")).toBe(1);

        expect(await storage.identityLinks.unlink({ from, actor })).toBe(false);
        expect(await harness.probe.countAuditEntries("identity_link.removed")).toBe(1);
        expect(await storage.auditLogs.verifyIntegrity()).toMatchObject({ ok: true });
      });

      it("un alias desenlazado puede volver a enlazarse a otro destino", async () => {
        const storage = harness.storage();
        await storage.identityLinks.link({ from, to, actor });
        await storage.identityLinks.unlink({ from, actor });
        const other = { provider: "supabase", subject: "user-other" };
        await expect(storage.identityLinks.link({ from, to: other, actor })).resolves.toMatchObject({ to: other });
      });
    });

    describe("invitations", () => {
      const owner = { provider: "supabase", subject: "owner" };
      const newcomer = { provider: "supabase", subject: "newcomer" };
      const expiresAt = () => new Date(Date.now() + 3_600_000);

      async function seed() {
        const storage = harness.storage();
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-owner",
          ownerIdentity: owner,
        });
        await storage.roles.create({ id: "role-editor", organizationId: "org-1", name: "Editor", permissionKeys: [] });
        await storage.roles.create({ id: "role-viewer", organizationId: "org-1", name: "Viewer", permissionKeys: [] });
        return storage;
      }

      const base = (overrides: Partial<Parameters<ReturnType<typeof harness.storage>["invitations"]["create"]>[0]> = {}) => ({
        id: "inv-1",
        organizationId: "org-1",
        email: "ana@example.com",
        roleIds: ["role-viewer", "role-editor"],
        tokenHash: "hash-1",
        invitedBy: owner,
        createdAt: new Date(),
        expiresAt: expiresAt(),
        ...overrides,
      });

      it("round-trips an invitation, roles and delivery bookkeeping", async () => {
        const storage = await seed();
        const created = await storage.invitations.create(base());
        expect(created).toMatchObject({
          id: "inv-1",
          email: "ana@example.com",
          status: "pending",
          invitedBy: owner,
          delivery: { status: "pending", attempts: 0, sends: 0 },
        });
        expect([...created.roleIds].sort()).toEqual(["role-editor", "role-viewer"]);
        expect((await storage.invitations.findByTokenHash("hash-1"))?.id).toBe("inv-1");
        expect(await storage.invitations.findByTokenHash("nope")).toBeNull();

        const at = new Date();
        await storage.invitations.recordDelivery("inv-1", { status: "failed", attempts: 3, error: "boom", at });
        await storage.invitations.recordDelivery("inv-1", { status: "sent", attempts: 1, at });
        const after = await storage.invitations.findById("inv-1");
        expect(after?.delivery).toMatchObject({ status: "sent", attempts: 4, sends: 2, lastError: undefined });
        expect(after?.delivery.sentAt?.getTime()).toBe(at.getTime());
      });

      it("allows one pending invitation per organization + e-mail, enforced by the database", async () => {
        const storage = await seed();
        await storage.invitations.create(base());
        await expect(storage.invitations.create(base({ id: "inv-2", tokenHash: "hash-2" }))).rejects.toMatchObject({
          reason: "duplicate_pending",
        });
        await storage.invitations.revoke("inv-1", new Date());
        await expect(storage.invitations.create(base({ id: "inv-3", tokenHash: "hash-3" }))).resolves.toBeDefined();
      });

      it("rejects unknown organizations and roles with an InvitationError", async () => {
        const storage = await seed();
        await expect(storage.invitations.create(base({ organizationId: "ghost" }))).rejects.toThrow(InvitationError);
        await expect(storage.invitations.create(base({ roleIds: ["ghost-role"] }))).rejects.toThrow(InvitationError);
      });

      it("expireStale only retires pending invitations that are past their expiry", async () => {
        const storage = await seed();
        await storage.invitations.create(base({ expiresAt: new Date(Date.now() - 1000) }));
        await storage.invitations.create(base({ id: "inv-b", tokenHash: "hash-b", email: "bob@example.com" }));
        expect(await storage.invitations.expireStale("org-1", "ana@example.com", new Date())).toBe(1);
        expect(await storage.invitations.expireStale("org-1", "bob@example.com", new Date())).toBe(0);
        expect((await storage.invitations.findById("inv-1"))?.status).toBe("expired");
      });

      it("rotateToken swaps the hash and refuses anything that is not pending", async () => {
        const storage = await seed();
        await storage.invitations.create(base());
        const rotated = await storage.invitations.rotateToken("inv-1", { tokenHash: "hash-new", expiresAt: expiresAt() });
        expect(rotated?.status).toBe("pending");
        expect(await storage.invitations.findByTokenHash("hash-1")).toBeNull();
        expect((await storage.invitations.findByTokenHash("hash-new"))?.id).toBe("inv-1");
        await storage.invitations.revoke("inv-1", new Date());
        expect(await storage.invitations.rotateToken("inv-1", { tokenHash: "x", expiresAt: expiresAt() })).toBeNull();
        expect(await storage.invitations.revoke("inv-1", new Date())).toBeNull();
      });

      it("markAccepted is a single-use claim: exactly one of many concurrent callers wins, and expiry is honoured", async () => {
        const storage = await seed();
        await storage.invitations.create(base());
        const claims = await Promise.all(
          Array.from({ length: 8 }, (_, n) =>
            storage.invitations.markAccepted({ tokenHash: "hash-1", identity: { provider: "p", subject: `s${n}` }, now: new Date() }),
          ),
        );
        expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

        await storage.invitations.create(base({ id: "inv-late", tokenHash: "hash-late", email: "late@example.com", expiresAt: new Date(Date.now() - 1) }));
        expect(await storage.invitations.markAccepted({ tokenHash: "hash-late", identity: newcomer, now: new Date() })).toBeNull();
      });

      it("pages newest first with a keyset cursor, optionally by status", async () => {
        const storage = await seed();
        for (let n = 1; n <= 5; n++) {
          await storage.invitations.create(
            base({ id: `inv-${n}`, tokenHash: `h${n}`, email: `u${n}@example.com`, createdAt: new Date(Date.UTC(2026, 0, n)) }),
          );
        }
        await storage.invitations.revoke("inv-2", new Date());
        const first = await storage.invitations.search("org-1", { limit: 2 });
        expect(first.map((i) => i.id)).toEqual(["inv-5", "inv-4"]);
        const second = await storage.invitations.search("org-1", { limit: 2, after: "inv-4" });
        expect(second.map((i) => i.id)).toEqual(["inv-3", "inv-2"]);
        expect((await storage.invitations.search("org-1", { status: "revoked" })).map((i) => i.id)).toEqual(["inv-2"]);
        expect(await storage.invitations.search("org-1", { after: "ghost" })).toEqual([]);
      });

      it("countCreatedSince filters by e-mail, organization and time", async () => {
        const storage = await seed();
        await storage.invitations.create(base({ createdAt: new Date("2026-01-01T00:00:00Z") }));
        await storage.invitations.create(base({ id: "inv-b", tokenHash: "hb", email: "bob@example.com", createdAt: new Date("2026-01-02T00:00:00Z") }));
        const since = new Date("2026-01-01T12:00:00Z");
        expect(await storage.invitations.countCreatedSince({ since })).toBe(1);
        expect(await storage.invitations.countCreatedSince({ since: new Date(0), email: "ana@example.com" })).toBe(1);
        expect(await storage.invitations.countCreatedSince({ since: new Date(0), organizationId: "org-1" })).toBe(2);
        expect(await storage.invitations.countCreatedSince({ since: new Date(0), organizationId: "other" })).toBe(0);
      });

      it("drops a deleted role from the invitation, and the invitations go with their organization", async () => {
        const storage = await seed();
        await storage.invitations.create(base());
        await storage.roles.delete("role-editor");
        expect((await storage.invitations.findById("inv-1"))?.roleIds).toEqual(["role-viewer"]);
      });

      it("runs the whole invitation flow through the service: invite, accept, then a replay fails", async () => {
        const storage = await seed();
        const sent: string[] = [];
        const service = createInvitationService({
          storage,
          acceptUrl: (token) => `https://app.test/invite/${token}`,
          sender: { send: async (message) => void sent.push(message.acceptUrl) },
        });
        const { acceptUrl, invitation } = await service.invite({
          organizationId: "org-1",
          email: "Ana@Example.com",
          roleIds: ["role-editor"],
          invitedBy: owner,
        });
        expect(sent).toEqual([acceptUrl]);
        const token = acceptUrl.split("/invite/")[1]!;

        const accepted = await service.accept({ token, identity: newcomer, verifiedEmail: "ana@example.com" });
        expect(accepted.membership.roleIds).toEqual(["role-editor"]);
        expect((await storage.invitations.findById(invitation.id))?.status).toBe("accepted");
        await expect(service.accept({ token, identity: newcomer, verifiedEmail: "ana@example.com" })).rejects.toMatchObject({
          reason: "already_accepted",
        });
        expect(await harness.probe.countAuditEntries("invitation.accepted")).toBe(1);
      });

      it("rolls the claim back when the membership step fails inside the transaction", async () => {
        const storage = await seed();
        await storage.invitations.create(base({ roleIds: ["role-viewer"] }));
        await expect(
          storage.transaction(async (tx) => {
            await tx.invitations.markAccepted({ tokenHash: "hash-1", identity: newcomer, now: new Date() });
            throw new Error("membership step failed");
          }),
        ).rejects.toThrow("membership step failed");
        expect((await storage.invitations.findById("inv-1"))?.status).toBe("pending");
      });
    });

    describe("ownership transfer and leaving", () => {
      const alice = { provider: "supabase", subject: "alice" };
      const bob = { provider: "supabase", subject: "bob" };

      async function seedTeam() {
        const storage = harness.storage();
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-alice",
          ownerIdentity: alice,
        });
        await storage.memberships.create({ id: "m-bob", organizationId: "org-1", identity: bob });
        await createOrganizationWithOwner(storage, {
          organizationId: "org-2",
          organizationName: "Other",
          ownerRoleId: "role-owner-2",
          membershipId: "m-eve",
          ownerIdentity: { provider: "supabase", subject: "eve" },
        });
        return storage;
      }

      it("hands the Owner role over atomically and audits it", async () => {
        const storage = await seedTeam();
        await transferOwnership(storage, { organizationId: "org-1", fromMembershipId: "m-alice", toMembershipId: "m-bob", actor: alice });
        expect((await storage.memberships.findById("m-bob"))?.roleIds).toEqual(["role-owner"]);
        expect((await storage.memberships.findById("m-alice"))?.roleIds).toEqual([]);
        expect(await harness.probe.countAuditEntries("organization.ownership_transferred")).toBe(1);
      });

      it("can keep the previous owner as a second Owner", async () => {
        const storage = await seedTeam();
        await transferOwnership(storage, { organizationId: "org-1", fromMembershipId: "m-alice", toMembershipId: "m-bob", actor: alice, keepPreviousOwner: true });
        expect((await storage.memberships.findById("m-alice"))?.roleIds).toEqual(["role-owner"]);
        expect((await storage.memberships.findById("m-bob"))?.roleIds).toEqual(["role-owner"]);
      });

      it("refuses members of another organization, a non-owner giver and a transfer to oneself", async () => {
        const storage = await seedTeam();
        const base = { organizationId: "org-1", actor: alice };
        await expect(transferOwnership(storage, { ...base, fromMembershipId: "m-alice", toMembershipId: "m-eve" })).rejects.toThrow(MembershipError);
        await expect(transferOwnership(storage, { ...base, fromMembershipId: "m-bob", toMembershipId: "m-alice" })).rejects.toThrow(MembershipError);
        await expect(transferOwnership(storage, { ...base, fromMembershipId: "m-alice", toMembershipId: "m-alice" })).rejects.toThrow(MembershipError);
        expect((await storage.memberships.findById("m-alice"))?.roleIds).toEqual(["role-owner"]);
        expect((await storage.memberships.findById("m-eve"))?.roleIds).toEqual(["role-owner-2"]);
      });

      it("lets a member leave, but never the last Owner", async () => {
        const storage = await seedTeam();
        expect(await leaveOrganization(storage, { organizationId: "org-1", identity: bob })).toBe(true);
        expect(await storage.memberships.findByIdentity("org-1", bob)).toBeNull();
        expect(await leaveOrganization(storage, { organizationId: "org-1", identity: bob })).toBe(false);
        await expect(leaveOrganization(storage, { organizationId: "org-1", identity: alice })).rejects.toThrow(MembershipError);
        expect(await storage.memberships.findByIdentity("org-1", alice)).not.toBeNull();
        expect(await harness.probe.countAuditEntries("membership.left")).toBe(1);
      });
    });
  });
}
