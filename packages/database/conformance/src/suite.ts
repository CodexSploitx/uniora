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
  applyRoleTemplates,
  dispatchOutbox,
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

    it("delete() y unassignOwnerRole() del último Owner fallan con el código estable last_owner (no membership_not_found)", async () => {
      const storage = harness.storage();
      const { ownerRole, membership } = await createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors",
        ownerRoleId: "role-owner",
        membershipId: "m-1",
        ownerIdentity: identity,
      });

      await expect(storage.memberships.delete(membership.id)).rejects.toMatchObject({ code: "last_owner" });
      await expect(storage.memberships.unassignOwnerRole(membership.id, ownerRole.id)).rejects.toMatchObject({ code: "last_owner" });
      await expect(storage.memberships.delete("no-such")).rejects.toMatchObject({ code: "membership_not_found" });
      // Nada debe haber cambiado.
      expect(await storage.memberships.findById(membership.id)).not.toBeNull();
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

      it("una suspensión con fecha de fin bloquea hasta esa fecha y después el miembro vuelve a estar activo solo", async () => {
        const { storage, a } = await seed();
        const engine = createAuthorizationEngine(storage);
        const input = { identity: alice, organizationId: "org-1", permission: "reports.read" };

        const until = new Date(Date.now() + 700);
        const suspended = await storage.memberships.suspend(a.id, { actor: admin, reason: "vacaciones", until });
        expect(suspended).toMatchObject({ status: "suspended", blocked: { by: admin, reason: "vacaciones" } });
        expect(suspended.blocked!.until!.getTime()).toBe(until.getTime());
        expect(await engine.can(input)).toBe(false);
        expect((await storage.memberships.findById(a.id))!.blocked!.until!.getTime()).toBe(until.getTime());
        expect(await storage.memberships.count({ organizationId: "org-1", status: "suspended" })).toBe(1);
        expect(await storage.memberships.count({ organizationId: "org-1", status: "blocked" })).toBe(0);
        expect((await storage.memberships.searchListing({ organizationId: "org-1", rolesPerMember: 1, status: "suspended" })).map((m) => m.id)).toEqual(["m-alice"]);
        // Ya suspendido: conserva la fecha original (idempotente).
        expect((await storage.memberships.suspend(a.id, { actor: bob, until: new Date(Date.now() + 3_600_000) })).blocked!.until!.getTime()).toBe(until.getTime());

        await new Promise((resolve) => setTimeout(resolve, 900));
        const lapsed = (await storage.memberships.findById(a.id))!;
        expect(lapsed.status).toBe("active");
        expect(lapsed.blocked).toBeUndefined();
        expect(await engine.can(input)).toBe(true);
        expect((await storage.memberships.findByIdentity("org-1", alice))!.status).toBe("active");
        expect((await storage.memberships.listByOrganization("org-1")).every((m) => m.status === "active")).toBe(true);
        expect(await storage.memberships.count({ organizationId: "org-1", status: "suspended" })).toBe(0);
        expect(await storage.memberships.count({ organizationId: "org-1", status: "active" })).toBe(2);
        expect((await storage.memberships.search({ organizationId: "org-1", status: "active" })).map((m) => m.id)).toEqual(["m-alice", "m-bob"]);
        expect((await storage.memberships.searchListing({ organizationId: "org-1", rolesPerMember: 1, status: "suspended" }))).toEqual([]);

        // Una suspensión vencida cuenta como "no bloqueado": se puede volver a suspender, o bloquear sin fecha.
        const again = await storage.memberships.block(a.id, { actor: admin });
        expect(again).toMatchObject({ status: "blocked", blocked: { by: admin } });
        expect(again.blocked!.until).toBeUndefined();
        expect(await engine.can(input)).toBe(false);
        expect((await storage.memberships.unblock(a.id, { actor: admin })).blocked).toBeUndefined();
      });

      it("rechaza una fecha de fin pasada o inválida, y no suspende por tiempo al último Owner activo", async () => {
        const { storage, owner, a, b } = await seed();
        const future = new Date(Date.now() + 60_000);
        await expect(storage.memberships.suspend(a.id, { actor: admin, until: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "membership_block_until_invalid" });
        await expect(storage.memberships.suspend(a.id, { actor: admin, until: new Date("nope") })).rejects.toMatchObject({ code: "membership_block_until_invalid" });
        expect((await storage.memberships.findById(a.id))!.status).toBe("active");

        await expect(storage.memberships.suspend(b.id, { actor: admin, until: future })).rejects.toMatchObject({ code: "last_owner" });
        await storage.memberships.assignOwnerRole(a.id, owner.id);
        await storage.memberships.suspend(b.id, { actor: admin, until: future });
        await expect(storage.memberships.block(a.id, { actor: admin })).rejects.toMatchObject({ code: "last_owner" });
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

    describe("roles — del sistema, descripción, clonar, reemplazar permisos y política al borrar", () => {
      const operator = { provider: "supabase", subject: "operator" };

      async function seed() {
        const storage = harness.storage();
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-owner",
          ownerIdentity: identity,
        });
        await storage.organizations.create({ id: "org-2", name: "Otra" });
        for (const key of ["a.read", "a.write", "b.read", "b.write"]) await storage.permissions.register({ key });
        return storage;
      }

      it("un rol puede ser del sistema y llevar descripción; los roles normales y el Owner no lo son", async () => {
        const storage = await seed();
        const system = await storage.roles.create({
          id: "r-sys", organizationId: "org-1", name: "Recepción", permissionKeys: ["a.read"], isSystem: true, description: "  Atiende la entrada  ",
        });
        expect(system).toMatchObject({ isSystem: true, description: "Atiende la entrada" });
        const custom = await storage.roles.create({ id: "r-custom", organizationId: "org-1", name: "Custom" });
        expect(custom.isSystem).toBe(false);
        expect(custom.description).toBeUndefined();
        const [owner] = await storage.roles.findByIds(["role-owner"]);
        expect(owner).toMatchObject({ isOwnerRole: true, isSystem: false });

        const [again] = await storage.roles.findByIds(["r-sys"]);
        expect(again).toMatchObject({ isSystem: true, description: "Atiende la entrada", permissionKeys: ["a.read"] });
        const summaries = await storage.roles.search({ organizationId: "org-1", isSystem: true });
        expect(summaries.map((role) => role.id)).toEqual(["r-sys"]);
        expect(await storage.roles.count({ organizationId: "org-1", isSystem: false })).toBe(2);
        await expect(
          storage.roles.create({ id: "r-big", organizationId: "org-1", name: "Big", description: "x".repeat(501) }),
        ).rejects.toMatchObject({ code: "role_description_invalid" });
      });

      it("un rol del sistema no se renombra ni se borra, pero sí cambian sus permisos y su descripción", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "r-sys", organizationId: "org-1", name: "Recepción", isSystem: true });
        await expect(storage.roles.rename("r-sys", "Otro")).rejects.toMatchObject({ code: "role_system_protected" });
        await expect(storage.roles.update("r-sys", { name: "Otro" })).rejects.toMatchObject({ code: "role_system_protected" });
        await expect(storage.roles.delete("r-sys")).rejects.toMatchObject({ code: "role_system_protected" });
        await expect(storage.roles.delete("r-sys", { members: "reject" })).rejects.toMatchObject({ code: "role_system_protected" });

        await storage.roles.grantPermission("r-sys", "a.read");
        expect(await storage.roles.update("r-sys", { description: "Nueva" })).toMatchObject({ description: "Nueva", name: "Recepción" });
        expect((await storage.roles.update("r-sys", { description: null })).description).toBeUndefined();
        expect((await storage.roles.findByIds(["r-sys"]))[0]).toMatchObject({ name: "Recepción", permissionKeys: ["a.read"] });
      });

      it("update cambia nombre y/o descripción, valida y protege al Owner", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "r-1", organizationId: "org-1", name: "Uno" });
        await storage.roles.create({ id: "r-2", organizationId: "org-1", name: "Dos" });
        expect(await storage.roles.update("r-1", { name: " Uno  bis ", description: "d" })).toMatchObject({ name: "Uno bis", description: "d" });
        await expect(storage.roles.update("r-1", {})).rejects.toMatchObject({ code: "role_update_empty" });
        await expect(storage.roles.update("r-1", { name: "Dos" })).rejects.toBeInstanceOf(RoleError);
        await expect(storage.roles.update("ghost", { name: "X" })).rejects.toMatchObject({ code: "role_not_found" });
        await expect(storage.roles.update("role-owner", { name: "Jefe" })).rejects.toBeInstanceOf(RoleError);
        await expect(storage.roles.update("role-owner", { description: "x" })).rejects.toBeInstanceOf(RoleError);
      });

      it("el nombre es único normalizado: mayúsculas, acentos y espacios no crean un rol distinto, ni siquiera en carrera", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "n-1", organizationId: "org-1", name: "Recepción" });
        for (const [index, variant] of ["recepción", "Recepcion", " RECEPCIÓN ", "Re  cepción"].entries()) {
          if (variant === "Re  cepción") continue; // different word once whitespace is collapsed
          await expect(
            storage.roles.create({ id: `n-dup-${index}`, organizationId: "org-1", name: variant, key: `dup-${index}` }),
          ).rejects.toBeInstanceOf(RoleError);
        }
        // Another organization may use the same name; the display name keeps its spelling.
        await storage.organizations.create({ id: "org-n2", name: "Segunda" });
        expect(await storage.roles.create({ id: "n-other", organizationId: "org-n2", name: "recepcion" })).toMatchObject({ name: "recepcion" });
        expect((await storage.roles.findByIds(["n-1"]))[0]).toMatchObject({ name: "Recepción" });

        // rename / update / clone follow the same rule, and a role may change the case of its own name.
        await storage.roles.create({ id: "n-2", organizationId: "org-1", name: "Otro" });
        await expect(storage.roles.rename("n-2", "RECEPCION")).rejects.toBeInstanceOf(RoleError);
        await expect(storage.roles.update("n-2", { name: "recepcion" })).rejects.toBeInstanceOf(RoleError);
        await expect(storage.roles.clone("n-1", { id: "n-3", name: "recepciÓn", key: "copy" })).rejects.toBeInstanceOf(RoleError);
        expect((await storage.roles.rename("n-1", "RECEPCIÓN")).name).toBe("RECEPCIÓN");
        expect((await storage.roles.update("n-1", { name: "Recepción" })).name).toBe("Recepción");

        // The protected Owner role keeps its name against look-alikes ("ÓWNER" has another key but reads the same).
        await expect(storage.roles.create({ id: "n-own", organizationId: "org-1", name: "OWNER", key: "jefe" })).rejects.toBeInstanceOf(RoleError);
        await expect(storage.roles.create({ id: "n-own2", organizationId: "org-1", name: "Ówner", key: "jefe-2" })).rejects.toBeInstanceOf(RoleError);

        // Concurrent creations of look-alike names: exactly one wins (the unique index, not a check-then-insert).
        const outcomes = await Promise.allSettled(
          ["Ventas", "ventas", "VENTAS", "Véntas"].map((name, index) =>
            storage.roles.create({ id: `race-${index}`, organizationId: "org-1", name, key: `race-${index}` }),
          ),
        );
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      });

      it("version sube con cada cambio real y expectedVersion rechaza una edición hecha desde una copia vieja", async () => {
        const storage = await seed();
        const role = await storage.roles.create({ id: "r-v", organizationId: "org-1", name: "Versionado", permissionKeys: ["a.read"] });
        expect(role.version).toBe(1);

        // update: sube; con la versión correcta pasa, con una vieja falla y no cambia nada.
        expect((await storage.roles.update("r-v", { description: "uno" })).version).toBe(2);
        expect((await storage.roles.update("r-v", { description: "dos", expectedVersion: 2 })).version).toBe(3);
        await expect(storage.roles.update("r-v", { description: "viejo", expectedVersion: 2 })).rejects.toMatchObject({ code: "role_version_conflict" });
        expect((await storage.roles.findByIds(["r-v"]))[0]).toMatchObject({ description: "dos", version: 3 });

        // setPermissions: solo sube si algo cambió; el conflicto no toca nada.
        await storage.roles.setPermissions("r-v", ["a.read"], { expectedVersion: 3 });
        expect((await storage.roles.findByIds(["r-v"]))[0]!.version).toBe(3);
        await storage.roles.setPermissions("r-v", ["a.read", "a.write"], { expectedVersion: 3 });
        expect((await storage.roles.findByIds(["r-v"]))[0]).toMatchObject({ version: 4, permissionKeys: ["a.read", "a.write"] });
        await expect(storage.roles.setPermissions("r-v", ["b.read"], { expectedVersion: 3 })).rejects.toMatchObject({ code: "role_version_conflict" });
        expect((await storage.roles.findByIds(["r-v"]))[0]).toMatchObject({ version: 4, permissionKeys: ["a.read", "a.write"] });

        // grant / revoke / rename: suben solo si hubo cambio.
        await storage.roles.grantPermission("r-v", "a.read");
        await storage.roles.revokePermission("r-v", "b.read");
        expect((await storage.roles.findByIds(["r-v"]))[0]!.version).toBe(4);
        await storage.roles.grantPermission("r-v", "b.read");
        await storage.roles.revokePermission("r-v", "b.read");
        expect((await storage.roles.findByIds(["r-v"]))[0]!.version).toBe(6);
        expect((await storage.roles.rename("r-v", "Renombrado")).version).toBe(7);

        // Valores que nunca coinciden son un error del llamador, no un conflicto.
        await expect(storage.roles.update("r-v", { description: "x", expectedVersion: 0 })).rejects.toBeInstanceOf(TypeError);
        await expect(storage.roles.setPermissions("r-v", [], { expectedVersion: 1.5 })).rejects.toBeInstanceOf(TypeError);
        // Un rol inexistente sigue siendo role_not_found aunque se pase expectedVersion.
        await expect(storage.roles.update("ghost", { name: "X", expectedVersion: 1 })).rejects.toMatchObject({ code: "role_not_found" });
      });

      it("setPermissions deja EXACTAMENTE esas claves, devuelve lo que cambió y es todo o nada", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "r-1", organizationId: "org-1", name: "Uno", permissionKeys: ["a.read", "b.read"] });

        const first = await storage.roles.setPermissions("r-1", ["a.read", "a.write", "a.write"]);
        expect(first).toEqual({ granted: ["a.write"], revoked: ["b.read"] });
        expect((await storage.roles.findByIds(["r-1"]))[0]?.permissionKeys.sort()).toEqual(["a.read", "a.write"]);

        expect(await storage.roles.setPermissions("r-1", ["a.read", "a.write"])).toEqual({ granted: [], revoked: [] });
        expect(await storage.roles.setPermissions("r-1", [])).toEqual({ granted: [], revoked: ["a.read", "a.write"] });

        // Una clave sin registrar: nada cambia (ni siquiera lo que sí era válido).
        await storage.roles.setPermissions("r-1", ["a.read"]);
        await expect(storage.roles.setPermissions("r-1", ["b.write", "nope.nope"])).rejects.toMatchObject({ code: "role_permission_invalid" });
        expect((await storage.roles.findByIds(["r-1"]))[0]?.permissionKeys).toEqual(["a.read"]);

        await expect(storage.roles.setPermissions("role-owner", ["a.read"])).rejects.toBeInstanceOf(RoleError);
        await expect(storage.roles.setPermissions("ghost", [])).rejects.toMatchObject({ code: "role_not_found" });
      });

      it("clone copia permisos y descripción, en la misma o en otra organización, y nunca es del sistema", async () => {
        const storage = await seed();
        await storage.roles.create({
          id: "r-sys", organizationId: "org-1", name: "Recepción", isSystem: true, description: "Entrada", permissionKeys: ["a.read", "b.write"],
        });
        const copy = await storage.roles.clone("r-sys", { id: "r-copy", name: "Recepción 2" });
        expect(copy).toMatchObject({ id: "r-copy", organizationId: "org-1", isSystem: false, description: "Entrada" });
        expect(copy.permissionKeys.sort()).toEqual(["a.read", "b.write"]);
        expect((await storage.roles.findByIds(["r-copy"]))[0]?.permissionKeys.sort()).toEqual(["a.read", "b.write"]);

        const elsewhere = await storage.roles.clone("r-sys", { id: "r-else", name: "Recepción", organizationId: "org-2", description: "Otra" });
        expect(elsewhere).toMatchObject({ organizationId: "org-2", description: "Otra" });
        // Cambiar la copia no toca al original.
        await storage.roles.revokePermission("r-copy", "a.read");
        expect((await storage.roles.findByIds(["r-sys"]))[0]?.permissionKeys.sort()).toEqual(["a.read", "b.write"]);

        await expect(storage.roles.clone("role-owner", { id: "r-x", name: "X" })).rejects.toMatchObject({ code: "owner_role_protected" });
        await expect(storage.roles.clone("ghost", { id: "r-y", name: "Y" })).rejects.toMatchObject({ code: "role_not_found" });
        await expect(storage.roles.clone("r-sys", { id: "r-z", name: "Recepción 2" })).rejects.toBeInstanceOf(RoleError);
        expect(await storage.roles.findByIds(["r-z"])).toEqual([]);
      });

      it("delete con política: detach (por defecto), reject y reassignTo", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "r-old", organizationId: "org-1", name: "Viejo", permissionKeys: ["a.read"] });
        await storage.roles.create({ id: "r-new", organizationId: "org-1", name: "Nuevo" });
        await storage.roles.create({ id: "r-foreign", organizationId: "org-2", name: "Ajeno" });
        for (const id of ["m-1", "m-2"]) {
          await storage.memberships.create({ id, organizationId: "org-1", identity: { provider: "p", subject: id } });
          await storage.memberships.assignRole(id, "r-old");
        }
        await storage.memberships.assignRole("m-2", "r-new");

        await expect(storage.roles.delete("r-old", { members: "reject" })).rejects.toMatchObject({ code: "role_in_use" });
        expect((await storage.roles.findByIds(["r-old"])).length).toBe(1);

        for (const bad of ["ghost", "r-foreign", "role-owner", "r-old"]) {
          await expect(storage.roles.delete("r-old", { members: { reassignTo: bad } })).rejects.toMatchObject({ code: "role_reassign_invalid" });
        }
        expect((await storage.roles.findByIds(["r-old"])).length).toBe(1);

        await storage.roles.delete("r-old", { members: { reassignTo: "r-new" } });
        expect(await storage.roles.findByIds(["r-old"])).toEqual([]);
        expect((await storage.memberships.findById("m-1"))?.roleIds).toEqual(["r-new"]);
        expect((await storage.memberships.findById("m-2"))?.roleIds).toEqual(["r-new"]);

        await storage.roles.delete("r-new", { members: "reject" }).catch((error) => expect(error).toMatchObject({ code: "role_in_use" }));
        await storage.roles.delete("r-new"); // detach
        expect((await storage.memberships.findById("m-1"))?.roleIds).toEqual([]);

        await storage.roles.create({ id: "r-empty", organizationId: "org-1", name: "Vacío" });
        await storage.roles.delete("r-empty", { members: "reject" });
        expect(await storage.roles.findByIds(["r-empty"])).toEqual([]);
        await expect(storage.roles.delete("role-owner")).rejects.toMatchObject({ code: "owner_role_protected" });
        await expect(storage.roles.delete("ghost", { members: "reject" })).rejects.toMatchObject({ code: "role_not_found" });
      });

      it("applyRoleTemplates crea los roles del sistema, es idempotente y respeta los roles propios del cliente", async () => {
        const storage = await seed();
        const templates = [
          { key: "reception", name: "Recepción", description: "Entrada", permissionKeys: ["a.read", "a.write"] },
          { key: "billing", name: "Facturación", permissionKeys: ["b.read"] },
        ];
        const first = await applyRoleTemplates(storage.roles, "org-1", templates);
        expect(first.created.map((role) => role.key).sort()).toEqual(["billing", "reception"]);
        expect(first.created.every((role) => role.isSystem)).toBe(true);

        const again = await applyRoleTemplates(storage.roles, "org-1", templates);
        expect(again.created).toEqual([]);
        expect(again.synced).toHaveLength(2);

        // Un cambio de plantilla se propaga a los roles del sistema…
        const changed = await applyRoleTemplates(storage.roles, "org-1", [{ ...templates[0]!, permissionKeys: ["a.read"], description: "Nueva" }, templates[1]!]);
        expect(changed.synced.find((role) => role.key === "reception")).toMatchObject({ description: "Nueva", permissionKeys: ["a.read"] });
        const reception = (await storage.roles.listByOrganization("org-1")).find((role) => role.key === "reception");
        expect(reception).toMatchObject({ description: "Nueva", permissionKeys: ["a.read"] });

        // …pero un rol con esa clave que el cliente creó por su cuenta no se toca.
        await storage.roles.create({ id: "r-mine", organizationId: "org-2", name: "Mi recepción", key: "reception", permissionKeys: ["b.write"] });
        const other = await applyRoleTemplates(storage.roles, "org-2", templates);
        expect(other.skipped).toEqual(["reception"]);
        expect(other.created.map((role) => role.key)).toEqual(["billing"]);
        expect((await storage.roles.findByIds(["r-mine"]))[0]).toMatchObject({ isSystem: false, permissionKeys: ["b.write"] });
      });

      it("con createAuditedStorage queda registrado el cambio de permisos, la clonación y la política de borrado", async () => {
        const raw = await seed();
        const storage = createAuditedStorage(raw, { actor: operator });
        await storage.roles.create({ id: "r-1", organizationId: "org-1", name: "Uno", permissionKeys: ["a.read"] });
        await storage.roles.setPermissions("r-1", ["a.write"]);
        await storage.roles.setPermissions("r-1", ["a.write"]);
        await storage.roles.update("r-1", { description: "Hola" });
        await storage.roles.clone("r-1", { id: "r-2", name: "Dos" });
        await storage.roles.delete("r-2", { members: "reject" });

        const replaced = await raw.auditLogs.search({ action: "role.permissions_replaced" });
        expect(replaced).toHaveLength(1);
        expect(replaced[0]?.metadata).toEqual({ granted: ["a.write"], revoked: ["a.read"] });
        expect(await raw.auditLogs.search({ action: "role.updated" })).toHaveLength(1);
        expect((await raw.auditLogs.search({ action: "role.cloned" }))[0]?.metadata).toMatchObject({ from: "r-1" });
        expect((await raw.auditLogs.search({ action: "role.deleted" }))[0]?.metadata).toEqual({ members: "reject" });
      });
    });

    describe("organizations — estado (active, suspended, archived) y actualización", () => {
      const operator = { provider: "supabase", subject: "operator" };
      const staff = { provider: "supabase", subject: "staff" };

      async function seedOrg(storage = harness.storage()) {
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-owner",
          ownerIdentity: identity,
        });
        await storage.permissions.register({ key: "reports.read" });
        await storage.roles.create({ id: "role-staff", organizationId: "org-1", name: "Staff", permissionKeys: ["reports.read"] });
        await storage.memberships.create({ id: "m-staff", organizationId: "org-1", identity: staff, roleIds: ["role-staff"] });
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        return storage;
      }

      it("una organización nace activa y sin cambio de estado", async () => {
        const storage = harness.storage();
        const created = await storage.organizations.create({ id: "org-1", name: "Acme" });
        expect(created).toMatchObject({ status: "active" });
        expect((await storage.organizations.findById("org-1"))?.statusChange).toBeUndefined();
      });

      it("setStatus guarda quién, cuándo y por qué; repetir el mismo estado no cambia nada", async () => {
        const storage = await seedOrg();
        const suspended = await storage.organizations.setStatus("org-1", { status: "suspended", actor: operator, reason: "  impago  " });
        expect(suspended).toMatchObject({ status: "suspended", statusChange: { by: operator, reason: "impago" } });
        expect(suspended?.statusChange?.at).toBeInstanceOf(Date);
        expect(await storage.organizations.findById("org-1")).toMatchObject({ status: "suspended", statusChange: { by: operator, reason: "impago" } });

        const again = await storage.organizations.setStatus("org-1", { status: "suspended", actor: { provider: "x", subject: "y" }, reason: "otra" });
        expect(again?.statusChange).toMatchObject({ by: operator, reason: "impago" });

        const restored = await storage.organizations.setStatus("org-1", { status: "active", actor: operator });
        expect(restored).toMatchObject({ status: "active", statusChange: { by: operator } });
        expect(restored?.statusChange?.reason).toBeUndefined();
        expect(await storage.organizations.setStatus("ghost", { status: "archived", actor: operator })).toBeNull();
      });

      it("rechaza un estado desconocido, un motivo enorme o sin actor", async () => {
        const storage = await seedOrg();
        await expect(
          storage.organizations.setStatus("org-1", { status: "deleted" as never, actor: operator }),
        ).rejects.toMatchObject({ code: "organization_status_invalid" });
        await expect(
          storage.organizations.setStatus("org-1", { status: "archived", actor: operator, reason: "x".repeat(501) }),
        ).rejects.toMatchObject({ code: "organization_status_invalid" });
        await expect(
          storage.organizations.setStatus("org-1", { status: "archived", actor: undefined as never }),
        ).rejects.toMatchObject({ code: "audit_actor_required" });
        expect((await storage.organizations.findById("org-1"))?.status).toBe("active");
      });

      it("mientras no esté activa, el motor deniega todo (Owner incluido) en can, access.check y snapshots; al reactivarla vuelve", async () => {
        const storage = await seedOrg();
        const engine = createAuthorizationEngine(storage);
        const asks = async () => ({
          ownerCan: await engine.can({ identity, organizationId: "org-1", permission: "anything.at_all" }),
          staffCan: await engine.can({ identity: staff, organizationId: "org-1", permission: "reports.read" }),
          featureOnly: await engine.access.check({ identity: staff, organizationId: "org-1", feature: "agenda" }),
          both: await engine.access.check({ identity: staff, organizationId: "org-1", permission: "reports.read", feature: "agenda" }),
          member: await engine.access.check({ identity: staff, organizationId: "org-1" }),
        });
        expect(await asks()).toEqual({ ownerCan: true, staffCan: true, featureOnly: true, both: true, member: true });

        for (const status of ["suspended", "archived"] as const) {
          await storage.organizations.setStatus("org-1", { status, actor: operator });
          expect(await asks()).toEqual({ ownerCan: false, staffCan: false, featureOnly: false, both: false, member: false });
        }

        await storage.organizations.setStatus("org-1", { status: "active", actor: operator });
        expect(await asks()).toEqual({ ownerCan: true, staffCan: true, featureOnly: true, both: true, member: true });
      });

      it("suspender una organización no toca a las demás", async () => {
        const storage = await seedOrg();
        await storage.organizations.create({ id: "org-2", name: "Otra" });
        const role = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
        const membership = await storage.memberships.create({ id: "m-2", organizationId: "org-2", identity });
        await storage.memberships.assignOwnerRole(membership.id, role.id);
        await storage.organizations.setStatus("org-1", { status: "suspended", actor: operator });
        const engine = createAuthorizationEngine(storage);
        expect(await engine.can({ identity, organizationId: "org-1", permission: "a.b" })).toBe(false);
        expect(await engine.can({ identity, organizationId: "org-2", permission: "a.b" })).toBe(true);
      });

      it("search y count filtran por estado (uno o varios), solos o con el texto", async () => {
        const storage = harness.storage();
        for (const [id, name] of [["a", "Alfa"], ["b", "Beta"], ["c", "Gamma"], ["d", "Alfa dos"]] as const) {
          await storage.organizations.create({ id, name });
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
        await storage.organizations.setStatus("b", { status: "suspended", actor: operator });
        await storage.organizations.setStatus("c", { status: "archived", actor: operator });
        await storage.organizations.setStatus("d", { status: "archived", actor: operator });
        const ids = (list: Array<{ id: string }>) => list.map((organization) => organization.id);

        expect(ids(await storage.organizations.search({ status: "active" }))).toEqual(["a"]);
        expect(ids(await storage.organizations.search({ status: "archived" }))).toEqual(["c", "d"]);
        expect(ids(await storage.organizations.search({ status: ["suspended", "archived"] }))).toEqual(["b", "c", "d"]);
        expect(ids(await storage.organizations.search({ status: "archived", query: "alfa" }))).toEqual(["d"]);
        expect(await storage.organizations.count({ status: "archived" })).toBe(2);
        expect(await storage.organizations.count({ status: ["active", "suspended"] })).toBe(2);
        expect(await storage.organizations.count({ status: "archived", query: "gam" })).toBe(1);
        expect(await storage.organizations.count()).toBe(4);
        await expect(storage.organizations.search({ status: "gone" as never })).rejects.toMatchObject({ code: "organization_status_invalid" });
      });

      describe("consultas entre organizaciones (por función efectiva y en lote)", () => {
        async function seedFleet() {
          const storage = harness.storage();
          for (const id of ["o1", "o2", "o3", "o4"]) {
            await storage.organizations.create({ id, name: `Org ${id}` });
            await new Promise((resolve) => setTimeout(resolve, 3));
          }
          await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
          await storage.features.register({ key: "agenda_chat", name: "Chat", defaultEnabled: true, parentKey: "agenda" });
          await storage.features.register({ key: "agenda_files", name: "Files", parentKey: "agenda" });
          await storage.features.register({ key: "reports", name: "Reports" });
          await storage.features.disable("o2", "agenda");
          await storage.features.enable("o2", "agenda_files"); // padre apagado: no cuenta
          await storage.features.enable("o3", "agenda_files");
          await storage.features.enable("o3", "reports");
          await storage.features.enable("o4", "reports");
          await storage.organizations.setStatus("o4", { status: "archived", actor: { provider: "p", subject: "op" } });
          return storage;
        }
        const ids = (list: Array<{ id: string }>) => list.map((organization) => organization.id);

        it("search({ feature }) devuelve las organizaciones donde está efectivamente activa (override, defecto y padres)", async () => {
          const storage = await seedFleet();
          const on = async (key: string) => ids(await storage.organizations.search({ feature: { key } }));
          expect(await on("agenda")).toEqual(["o1", "o3", "o4"]);
          expect(await on("agenda_chat")).toEqual(["o1", "o3", "o4"]);
          expect(await on("agenda_files")).toEqual(["o3"]);
          expect(await on("reports")).toEqual(["o3", "o4"]);
          expect(await on("nope")).toEqual([]);
        });

        it("con enabled: false devuelve las que NO la tienen, y combina con estado, texto y paginación", async () => {
          const storage = await seedFleet();
          const off = (key: string) => storage.organizations.search({ feature: { key, enabled: false } }).then(ids);
          expect(await off("agenda")).toEqual(["o2"]);
          expect(await off("agenda_files")).toEqual(["o1", "o2", "o4"]);
          expect(await off("reports")).toEqual(["o1", "o2"]);
          expect(await off("nope")).toEqual(["o1", "o2", "o3", "o4"]);

          expect(ids(await storage.organizations.search({ feature: { key: "reports" }, status: "active" }))).toEqual(["o3"]);
          expect(ids(await storage.organizations.search({ feature: { key: "agenda" }, query: "o3" }))).toEqual(["o3"]);
          expect(ids(await storage.organizations.search({ feature: { key: "agenda" }, limit: 2 }))).toEqual(["o1", "o3"]);
          const third = (await storage.organizations.search({ feature: { key: "agenda" }, limit: 2 }))[1]!;
          expect(
            ids(await storage.organizations.search({ feature: { key: "agenda" }, after: { createdAt: third.createdAt, id: third.id } })),
          ).toEqual(["o4"]);
        });

        it("count({ feature }) coincide con search", async () => {
          const storage = await seedFleet();
          expect(await storage.organizations.count({ feature: { key: "agenda" } })).toBe(3);
          expect(await storage.organizations.count({ feature: { key: "agenda", enabled: false } })).toBe(1);
          expect(await storage.organizations.count({ feature: { key: "reports" }, status: "archived" })).toBe(1);
          expect(await storage.organizations.count({ feature: { key: "nope" } })).toBe(0);
        });

        it("features.listEffectiveMany resuelve varias organizaciones en una llamada, igual que listEffective", async () => {
          const storage = await seedFleet();
          const many = await storage.features.listEffectiveMany(["o1", "o2", "o3", "ghost", "o1"], { keys: ["agenda", "agenda_files"] });
          expect(Object.keys(many).sort()).toEqual(["ghost", "o1", "o2", "o3"]);
          for (const organizationId of ["o1", "o2", "o3"]) {
            expect(many[organizationId]).toEqual(await storage.features.listEffective(organizationId, { keys: ["agenda", "agenda_files"] }));
          }
          expect(Object.fromEntries(many.o2!.map((feature) => [feature.key, [feature.enabled, feature.reason]]))).toEqual({
            agenda: [false, "disabled"],
            agenda_files: [false, "parent_disabled"],
          });
          expect(many.ghost!.every((feature) => feature.override === undefined)).toBe(true);
          expect(await storage.features.listEffectiveMany([])).toEqual({});
          const everything = await storage.features.listEffectiveMany(["o3"]);
          expect(everything.o3).toHaveLength(4);
        });

        it("listEffectiveMany rechaza más de 500 organizaciones por llamada", async () => {
          const storage = harness.storage();
          await expect(
            storage.features.listEffectiveMany(Array.from({ length: 501 }, (_, n) => `org-${n}`)),
          ).rejects.toMatchObject({ code: "feature_invalid" });
        });
      });

      it("update cambia nombre y/o slug a la vez, valida y devuelve null si no existe", async () => {
        const storage = harness.storage();
        await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
        await storage.organizations.create({ id: "org-2", name: "Otra", slug: "otra" });

        expect(await storage.organizations.update("org-1", { name: " Acme  Global ", slug: "acme-global" })).toMatchObject({
          name: "Acme Global",
          slug: "acme-global",
        });
        expect(await storage.organizations.update("org-1", { name: "Solo nombre" })).toMatchObject({ name: "Solo nombre", slug: "acme-global" });
        expect(await storage.organizations.update("org-1", { slug: "solo-slug" })).toMatchObject({ name: "Solo nombre", slug: "solo-slug" });
        expect(await storage.organizations.update("org-1", { slug: "solo-slug" })).toMatchObject({ slug: "solo-slug" });
        expect(await storage.organizations.update("ghost", { name: "X" })).toBeNull();

        await expect(storage.organizations.update("org-1", {})).rejects.toMatchObject({ code: "organization_update_empty" });
        await expect(storage.organizations.update("org-1", { slug: "otra" })).rejects.toMatchObject({ code: "organization_slug_taken" });
        await expect(storage.organizations.update("org-1", { slug: "Not Valid" })).rejects.toMatchObject({ code: "organization_slug_invalid" });
        await expect(storage.organizations.update("org-1", { name: "  " })).rejects.toMatchObject({ code: "organization_name_invalid" });
        expect(await storage.organizations.findById("org-1")).toMatchObject({ name: "Solo nombre", slug: "solo-slug" });
      });

      it("version sube con cada cambio y expectedVersion rechaza una edición hecha desde una copia vieja", async () => {
        const storage = harness.storage();
        const created = await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
        expect(created.version).toBe(1);

        expect((await storage.organizations.rename("org-1", "Acme Uno"))?.version).toBe(2);
        expect((await storage.organizations.update("org-1", { name: "Acme Dos", expectedVersion: 2 }))?.version).toBe(3);
        await expect(storage.organizations.update("org-1", { name: "Viejo", expectedVersion: 2 })).rejects.toMatchObject({
          code: "organization_version_conflict",
        });
        expect(await storage.organizations.findById("org-1")).toMatchObject({ name: "Acme Dos", version: 3 });

        // setStatus sube solo cuando el estado cambia de verdad.
        const actor = { provider: "test", subject: "admin" };
        expect((await storage.organizations.setStatus("org-1", { status: "suspended", actor }))?.version).toBe(4);
        expect((await storage.organizations.setStatus("org-1", { status: "suspended", actor }))?.version).toBe(4);
        expect((await storage.organizations.update("org-1", { slug: "acme-dos", expectedVersion: 4 }))?.version).toBe(5);

        // Un conflicto de slug no consume versión, y una organización inexistente sigue devolviendo null.
        await storage.organizations.create({ id: "org-2", name: "Otra", slug: "otra" });
        await expect(storage.organizations.update("org-1", { slug: "otra", expectedVersion: 5 })).rejects.toMatchObject({ code: "organization_slug_taken" });
        expect((await storage.organizations.findById("org-1"))!.version).toBe(5);
        expect(await storage.organizations.update("ghost", { name: "X", expectedVersion: 1 })).toBeNull();
        await expect(storage.organizations.update("org-1", { name: "X", expectedVersion: 0 })).rejects.toBeInstanceOf(TypeError);
      });

      it("con createAuditedStorage queda registrado quién, de qué a qué y por qué", async () => {
        const raw = harness.storage();
        const storage = createAuditedStorage(raw, { actor: operator });
        await storage.organizations.create({ id: "org-1", name: "Acme" });
        await storage.organizations.update("org-1", { name: "Acme 2" });
        await storage.organizations.setStatus("org-1", { status: "suspended", actor: operator, reason: "impago" });
        await storage.organizations.setStatus("org-1", { status: "suspended", actor: operator });

        const updated = await raw.auditLogs.search({ action: "organization.updated" });
        expect(updated).toHaveLength(1);
        expect(updated[0]?.metadata).toMatchObject({ changed: { name: { from: "Acme", to: "Acme 2" } } });
        const changes = await raw.auditLogs.search({ action: "organization.status_changed" });
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
          organizationId: "org-1",
          actor: operator,
          metadata: { from: "active", to: "suspended", reason: "impago" },
        });
      });
    });

    describe("permisos — grupos e implicaciones", () => {
      const staff = { provider: "supabase", subject: "staff" };

      async function seed() {
        const storage = harness.storage();
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-owner",
          ownerIdentity: identity,
        });
        await storage.permissions.register({ key: "appointments.read", group: "Agenda" });
        await storage.permissions.register({ key: "appointments.write", group: "Agenda", implies: ["appointments.read"] });
        await storage.permissions.register({ key: "appointments.admin", group: "Agenda", implies: ["appointments.write"] });
        await storage.permissions.register({ key: "reports.read", group: "Reportes" });
        return storage;
      }

      it("guarda grupo e implicaciones; re-registrar sin ellas las borra", async () => {
        const storage = await seed();
        expect(await storage.permissions.findByKey("appointments.write")).toMatchObject({ group: "Agenda", implies: ["appointments.read"] });
        expect((await storage.permissions.findByKey("reports.read"))?.implies ?? []).toEqual([]);
        await storage.permissions.register({ key: "appointments.write" });
        const cleared = await storage.permissions.findByKey("appointments.write");
        expect(cleared?.group).toBeUndefined();
        expect(cleared?.implies ?? []).toEqual([]);
        await storage.permissions.register({ key: "appointments.write", group: "  Agenda  ", implies: ["appointments.read", "appointments.read"] });
        expect(await storage.permissions.findByKey("appointments.write")).toMatchObject({ group: "Agenda", implies: ["appointments.read"] });
      });

      it("rechaza implicaciones inválidas: desconocida, a sí misma, ciclo, demasiado profunda o demasiadas", async () => {
        const storage = await seed();
        const code = { code: "permission_implication_invalid" };
        await expect(storage.permissions.register({ key: "x.y", implies: ["nope.read"] })).rejects.toMatchObject(code);
        await expect(storage.permissions.register({ key: "x.y", implies: ["x.y"] })).rejects.toMatchObject(code);
        // appointments.read -> admin cierra el ciclo admin -> write -> read -> admin
        await expect(storage.permissions.register({ key: "appointments.read", implies: ["appointments.admin"] })).rejects.toMatchObject(code);
        expect(await storage.permissions.findByKey("x.y")).toBeNull();

        let previous = "chain.p0";
        await storage.permissions.register({ key: previous });
        for (let level = 1; level <= 8; level += 1) {
          const key = `chain.p${level}`;
          await storage.permissions.register({ key, implies: [previous] });
          previous = key;
        }
        await expect(storage.permissions.register({ key: "chain.p9", implies: [previous] })).rejects.toMatchObject(code);

        for (let index = 0; index < 21; index += 1) await storage.permissions.register({ key: `many.p${index}` });
        await expect(
          storage.permissions.register({ key: "many.all", implies: Array.from({ length: 21 }, (_, index) => `many.p${index}`) }),
        ).rejects.toMatchObject(code);
        await expect(storage.permissions.register({ key: "x.y", group: "g".repeat(101) })).rejects.toMatchObject({ code: "permission_group_invalid" });
      });

      it("impliedBy y expand recorren la cadena completa", async () => {
        const storage = await seed();
        expect(await storage.permissions.impliedBy("appointments.read")).toEqual(["appointments.admin", "appointments.write"]);
        expect(await storage.permissions.impliedBy("appointments.admin")).toEqual([]);
        expect(await storage.permissions.impliedBy("unknown.key")).toEqual([]);
        expect(await storage.permissions.expand(["appointments.admin"])).toEqual(["appointments.admin", "appointments.read", "appointments.write"]);
        expect(await storage.permissions.expand(["reports.read", "unknown.key"])).toEqual(["reports.read", "unknown.key"]);
      });

      it("un rol con un permiso mayor pasa can() de los que implica, también por la cadena; al revés no", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "r-admin", organizationId: "org-1", name: "Admin agenda", permissionKeys: ["appointments.admin"] });
        await storage.roles.create({ id: "r-reader", organizationId: "org-1", name: "Lector", permissionKeys: ["appointments.read"] });
        await storage.memberships.create({ id: "m-admin", organizationId: "org-1", identity: staff, roleIds: ["r-admin"] });
        const reader = { provider: "supabase", subject: "reader" };
        await storage.memberships.create({ id: "m-reader", organizationId: "org-1", identity: reader, roleIds: ["r-reader"] });
        const engine = createAuthorizationEngine(storage);
        const can = (who: typeof staff, permission: string) => engine.can({ identity: who, organizationId: "org-1", permission });
        expect(await can(staff, "appointments.admin")).toBe(true);
        expect(await can(staff, "appointments.write")).toBe(true);
        expect(await can(staff, "appointments.read")).toBe(true);
        expect(await can(staff, "reports.read")).toBe(false);
        expect(await can(reader, "appointments.read")).toBe(true);
        expect(await can(reader, "appointments.write")).toBe(false);
        expect(await engine.access.check({ identity: staff, organizationId: "org-1", permission: "appointments.read" })).toBe(true);
      });

      it("search y count filtran por grupo; unregister se niega si otro permiso lo implica", async () => {
        const storage = await seed();
        expect((await storage.permissions.search({ group: "Agenda" })).map((permission) => permission.key)).toEqual([
          "appointments.admin",
          "appointments.read",
          "appointments.write",
        ]);
        expect(await storage.permissions.count({ group: "Reportes" })).toBe(1);
        await expect(storage.permissions.unregister("appointments.read")).rejects.toMatchObject({ code: "permission_has_dependents" });
        await storage.permissions.unregister("appointments.admin");
        await storage.permissions.unregister("appointments.write");
        await storage.permissions.unregister("appointments.read");
        expect(await storage.permissions.findByKey("appointments.read")).toBeNull();
      });
    });

    describe("outbox — eventos tras el commit", () => {
      // Un instante justo después de "ahora": los eventos que crea la prueba ya están disponibles en at(0).
      let base = Date.now() + 1000;
      beforeEach(() => {
        base = Date.now() + 1000;
      });
      const at = (seconds: number) => new Date(base + seconds * 1000);

      it("encola con seq creciente, valida y rechaza un id repetido", async () => {
        const { outbox } = harness.storage();
        const first = await outbox.enqueue({ id: "e1", type: "member.blocked", organizationId: "org-1", payload: { who: "a", nested: { n: 1 } } });
        const second = await outbox.enqueue({ id: "e2", type: "member.unblocked" });
        expect(second.seq).toBeGreaterThan(first.seq);
        expect(first).toMatchObject({ id: "e1", status: "pending", attempts: 0, organizationId: "org-1", payload: { who: "a", nested: { n: 1 } } });
        expect(first.createdAt).toBeInstanceOf(Date);
        expect(second.payload).toBeUndefined();
        await expect(outbox.enqueue({ id: "e1", type: "x" })).rejects.toMatchObject({ code: "outbox_event_exists" });
        await expect(outbox.enqueue({ id: "", type: "x" })).rejects.toMatchObject({ code: "outbox_event_invalid" });
        await expect(outbox.enqueue({ id: "e3", type: "" })).rejects.toMatchObject({ code: "outbox_event_invalid" });
        await expect(outbox.enqueue({ id: "e3", type: "t", payload: { big: "x".repeat(17 * 1024) } })).rejects.toMatchObject({ code: "outbox_payload_invalid" });
        expect(await outbox.count()).toBe(2);
      });

      it("el evento nace con el cambio: un rollback no deja evento y un commit no lo pierde", async () => {
        const storage = harness.storage();
        await expect(
          storage.transaction(async (tx) => {
            await tx.organizations.create({ id: "org-rb", name: "Rollback" });
            await tx.outbox.enqueue({ id: "e-rb", type: "organization.created", organizationId: "org-rb" });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await storage.outbox.findById("e-rb")).toBeNull();
        expect(await storage.organizations.findById("org-rb")).toBeNull();

        await storage.transaction(async (tx) => {
          await tx.organizations.create({ id: "org-ok", name: "Ok" });
          await tx.outbox.enqueue({ id: "e-ok", type: "organization.created", organizationId: "org-ok" });
        });
        expect(await storage.outbox.findById("e-ok")).toMatchObject({ status: "pending", organizationId: "org-ok" });
      });

      it("claim arrienda los eventos por orden y filtra; el arriendo vencido los devuelve", async () => {
        const { outbox } = harness.storage();
        for (const [id, type, organizationId] of [["e1", "a.x", "org-1"], ["e2", "b.x", "org-2"], ["e3", "a.x", "org-2"]] as const) {
          await outbox.enqueue({ id, type, organizationId });
        }
        expect((await outbox.claim({ type: "b.x", now: at(0) })).map((event) => event.id)).toEqual(["e2"]);
        expect((await outbox.claim({ organizationId: "org-2", now: at(0) })).map((event) => event.id)).toEqual(["e3"]);
        const mine = await outbox.claim({ limit: 5, leaseSeconds: 30, now: at(0) });
        expect(mine.map((event) => event.id)).toEqual(["e1"]);
        expect(mine[0]).toMatchObject({ attempts: 1, status: "pending" });
        expect(await outbox.claim({ now: at(20) })).toEqual([]);
        expect((await outbox.claim({ now: at(31), limit: 1 })).map((event) => [event.id, event.attempts])).toEqual([["e1", 2]]);
        await expect(outbox.claim({ limit: 101 })).rejects.toMatchObject({ code: "outbox_claim_invalid" });
        await expect(outbox.claim({ leaseSeconds: 0 })).rejects.toMatchObject({ code: "outbox_claim_invalid" });
      });

      it("dos trabajadores a la vez nunca reciben el mismo evento", async () => {
        const { outbox } = harness.storage();
        for (let index = 0; index < 12; index += 1) await outbox.enqueue({ id: `c${index}`, type: "t" });
        const batches = await Promise.all([1, 2, 3].map(() => outbox.claim({ limit: 5, now: at(0) })));
        const ids = batches.flat().map((event) => event.id);
        expect(ids).toHaveLength(12);
        expect(new Set(ids).size).toBe(12);
        for (const batch of batches) expect(batch.map((event) => event.seq)).toEqual([...batch.map((event) => event.seq)].sort((a, b) => a - b));
      });

      it("complete, fail con reintento, dead tras maxAttempts, requeue y pruneDelivered", async () => {
        const { outbox } = harness.storage();
        await outbox.enqueue({ id: "e1", type: "t" });
        await outbox.enqueue({ id: "e2", type: "t" });
        await outbox.claim({ now: at(0) });
        expect(await outbox.complete(["e1", "e1", "nope"], at(1))).toBe(1);
        expect(await outbox.complete(["e1"], at(2))).toBe(0);
        expect(await outbox.complete([], at(2))).toBe(0);
        expect(await outbox.fail("e2", { error: "boom", retryAt: at(60), maxAttempts: 2 })).toBe("pending");
        expect(await outbox.claim({ now: at(30) })).toEqual([]);
        expect(await outbox.claim({ now: at(61) })).toMatchObject([{ id: "e2", attempts: 2, lastError: "boom" }]);
        expect(await outbox.fail("e2", { error: "boom again", retryAt: at(120), maxAttempts: 2 })).toBe("dead");
        expect(await outbox.fail("e2", { error: "x", retryAt: at(0), maxAttempts: 2 })).toBeNull();
        expect(await outbox.claim({ now: at(500) })).toEqual([]);
        expect((await outbox.search({ status: "dead" })).map((event) => event.id)).toEqual(["e2"]);
        expect(await outbox.requeue("e2", at(600))).toBe(true);
        expect(await outbox.requeue("e1", at(600))).toBe(false);
        expect(await outbox.findById("e2")).toMatchObject({ status: "pending", attempts: 0, lastError: undefined });
        expect(await outbox.pruneDelivered(at(1))).toBe(0);
        expect(await outbox.pruneDelivered(at(3))).toBe(1);
        expect(await outbox.findById("e1")).toBeNull();
        expect(await outbox.count({ status: "pending" })).toBe(1);
      });

      it("search pagina con cursor por seq y filtra por estado, organización y tipo", async () => {
        const { outbox } = harness.storage();
        for (let index = 0; index < 5; index += 1) await outbox.enqueue({ id: `s${index}`, type: index % 2 ? "odd" : "even", organizationId: index < 3 ? "org-1" : "org-2" });
        const pageOne = await outbox.search({ limit: 2 });
        const pageTwo = await outbox.search({ limit: 2, afterSeq: pageOne.at(-1)!.seq });
        expect([...pageOne, ...pageTwo].map((event) => event.id)).toEqual(["s0", "s1", "s2", "s3"]);
        expect((await outbox.search({ organizationId: "org-2" })).map((event) => event.id)).toEqual(["s3", "s4"]);
        expect(await outbox.count({ type: "odd" })).toBe(2);
        expect(await outbox.count({ status: "delivered" })).toBe(0);
      });

      it("un storage auditado con outbox deja el evento en la misma transacción que el cambio", async () => {
        const raw = harness.storage();
        const audited = createAuditedStorage(raw, { actor: identity, outbox: true });
        await audited.organizations.create({ id: "org-1", name: "Acme" });
        await audited.permissions.register({ key: "reports.read" });
        const events = await raw.outbox.search();
        expect(events.map((event) => event.type)).toEqual(["organization.created", "permission.registered"]);
        expect(events[0]).toMatchObject({ organizationId: "org-1", payload: { actor: identity, target: { type: "organization", id: "org-1" } } });
        const delivered: string[] = [];
        const result = await dispatchOutbox(raw.outbox, (event) => void delivered.push(event.type), { now: () => at(0) });
        expect(result).toEqual({ claimed: 2, delivered: 2, retried: 0, dead: 0 });
        expect(delivered).toEqual(["organization.created", "permission.registered"]);
        expect(await raw.outbox.count({ status: "delivered" })).toBe(2);
      });
    });

    describe("entitlements — límites y consumo por organización", () => {
      let base = Date.UTC(2026, 4, 15, 12, 0, 0);
      beforeEach(() => {
        base = Date.UTC(2026, 4, 15, 12, 0, 0);
      });
      const day = (offset: number) => new Date(base + offset * 24 * 3600 * 1000);

      async function seed() {
        const storage = harness.storage();
        await storage.organizations.create({ id: "org-1", name: "Acme" });
        await storage.organizations.create({ id: "org-2", name: "Otra" });
        await storage.entitlements.define({ key: "seats", name: "  Puestos ", period: "lifetime", defaultLimit: 3 });
        await storage.entitlements.define({ key: "reports_per_month", period: "monthly", defaultLimit: 2 });
        await storage.entitlements.define({ key: "exports_per_day", period: "daily" });
        return storage;
      }

      it("define es un upsert completo, valida y lista ordenado", async () => {
        const storage = await seed();
        expect(await storage.entitlements.findDefinition("seats")).toMatchObject({ key: "seats", name: "Puestos", period: "lifetime", defaultLimit: 3 });
        expect(await storage.entitlements.findDefinition("exports_per_day")).toMatchObject({ name: "exports_per_day", defaultLimit: null });
        expect((await storage.entitlements.listDefinitions()).map((definition) => definition.key)).toEqual(["exports_per_day", "reports_per_month", "seats"]);
        await storage.entitlements.define({ key: "seats" });
        expect(await storage.entitlements.findDefinition("seats")).toMatchObject({ period: "lifetime", defaultLimit: null });
        await expect(storage.entitlements.define({ key: "Bad Key" })).rejects.toMatchObject({ code: "entitlement_key_invalid" });
        await expect(storage.entitlements.define({ key: "x", defaultLimit: -1 })).rejects.toMatchObject({ code: "entitlement_limit_invalid" });
        await expect(storage.entitlements.define({ key: "x", defaultLimit: 1.5 })).rejects.toMatchObject({ code: "entitlement_limit_invalid" });
        await expect(storage.entitlements.define({ key: "x", period: "weekly" as never })).rejects.toMatchObject({ code: "entitlement_invalid" });
        await expect(storage.entitlements.define({ key: "x", name: " " })).rejects.toMatchObject({ code: "entitlement_name_invalid" });
      });

      it("sin override rige el límite por defecto; setLimit lo cambia por organización y clearLimit lo devuelve", async () => {
        const storage = await seed();
        expect(await storage.entitlements.get("org-1", "seats")).toMatchObject({ limit: 3, source: "default", used: 0, remaining: 3 });
        expect(await storage.entitlements.setLimit("org-1", "seats", 10)).toMatchObject({ limit: 10, source: "override", remaining: 10 });
        expect(await storage.entitlements.get("org-2", "seats")).toMatchObject({ limit: 3, source: "default" });
        expect(await storage.entitlements.setLimit("org-1", "seats", null)).toMatchObject({ limit: null, source: "override", remaining: null });
        expect(await storage.entitlements.setLimit("org-1", "seats", 0)).toMatchObject({ limit: 0, remaining: 0 });
        expect(await storage.entitlements.clearLimit("org-1", "seats")).toMatchObject({ limit: 3, source: "default" });
        await expect(storage.entitlements.setLimit("org-1", "seats", -5)).rejects.toMatchObject({ code: "entitlement_limit_invalid" });
        await expect(storage.entitlements.setLimit("org-1", "nope", 5)).rejects.toMatchObject({ code: "entitlement_unknown" });
        await expect(storage.entitlements.setLimit("ghost", "seats", 5)).rejects.toMatchObject({ code: "entitlement_organization_unknown" });
        await expect(storage.entitlements.get("org-1", "nope")).rejects.toMatchObject({ code: "entitlement_unknown" });
      });

      it("consume toma si cabe y no toma nada si pasaría el límite; release devuelve sin bajar de cero", async () => {
        const storage = await seed();
        const { entitlements } = storage;
        expect(await entitlements.consume("org-1", "seats")).toEqual({ allowed: true, used: 1, limit: 3, remaining: 2 });
        expect(await entitlements.consume("org-1", "seats", 2)).toEqual({ allowed: true, used: 3, limit: 3, remaining: 0 });
        expect(await entitlements.consume("org-1", "seats")).toEqual({ allowed: false, used: 3, limit: 3, remaining: 0 });
        expect(await entitlements.consume("org-1", "seats", 5)).toMatchObject({ allowed: false, used: 3 });
        expect(await entitlements.consume("org-2", "seats")).toMatchObject({ allowed: true, used: 1 });
        expect(await entitlements.release("org-1", "seats")).toMatchObject({ used: 2, remaining: 1 });
        expect(await entitlements.consume("org-1", "seats")).toMatchObject({ allowed: true, used: 3 });
        expect(await entitlements.release("org-1", "seats", 99)).toMatchObject({ used: 0 });
        await expect(entitlements.consume("org-1", "seats", 0)).rejects.toMatchObject({ code: "entitlement_amount_invalid" });
        await expect(entitlements.consume("org-1", "seats", 1.5)).rejects.toMatchObject({ code: "entitlement_amount_invalid" });
        await expect(entitlements.consume("org-1", "nope")).rejects.toMatchObject({ code: "entitlement_unknown" });
        await expect(entitlements.consume("ghost", "seats")).rejects.toMatchObject({ code: "entitlement_organization_unknown" });
        await entitlements.setLimit("org-1", "seats", 0);
        expect(await entitlements.consume("org-1", "seats")).toMatchObject({ allowed: false, used: 0, limit: 0 });
      });

      it("un límite ilimitado siempre permite y sigue contando", async () => {
        const storage = await seed();
        expect(await storage.entitlements.consume("org-1", "exports_per_day", 500, { now: day(0) })).toEqual({ allowed: true, used: 500, limit: null, remaining: null });
        expect(await storage.entitlements.consume("org-1", "exports_per_day", 500, { now: day(0) })).toMatchObject({ used: 1000 });
      });

      it("el uso empieza de cero en cada ventana (mensual y diaria, UTC) y lifetime nunca", async () => {
        const storage = await seed();
        const { entitlements } = storage;
        expect(await entitlements.consume("org-1", "reports_per_month", 2, { now: day(0) })).toMatchObject({ allowed: true, used: 2 });
        expect(await entitlements.consume("org-1", "reports_per_month", 1, { now: day(5) })).toMatchObject({ allowed: false, used: 2 });
        expect(await entitlements.consume("org-1", "reports_per_month", 1, { now: day(20) })).toMatchObject({ allowed: true, used: 1 });
        expect(await entitlements.get("org-1", "reports_per_month", { now: day(0) })).toMatchObject({
          used: 2,
          windowStart: new Date(Date.UTC(2026, 4, 1)),
          windowEnd: new Date(Date.UTC(2026, 5, 1)),
        });
        await entitlements.consume("org-1", "exports_per_day", 7, { now: day(0) });
        expect(await entitlements.get("org-1", "exports_per_day", { now: day(0) })).toMatchObject({ used: 7, windowEnd: new Date(Date.UTC(2026, 4, 16)) });
        expect(await entitlements.get("org-1", "exports_per_day", { now: day(1) })).toMatchObject({ used: 0 });
        await entitlements.consume("org-1", "seats", 2, { now: day(0) });
        expect(await entitlements.get("org-1", "seats", { now: day(400) })).toMatchObject({ used: 2, windowEnd: undefined });
      });

      it("list devuelve todas las definiciones con el uso de la ventana actual", async () => {
        const storage = await seed();
        await storage.entitlements.setLimit("org-1", "reports_per_month", 5);
        await storage.entitlements.consume("org-1", "seats", 1, { now: day(0) });
        await storage.entitlements.consume("org-1", "reports_per_month", 4, { now: day(0) });
        await storage.entitlements.consume("org-1", "reports_per_month", 1, { now: day(40) });
        const list = await storage.entitlements.list("org-1", { now: day(0) });
        expect(list.map((status) => [status.key, status.used, status.limit, status.source])).toEqual([
          ["exports_per_day", 0, null, "default"],
          ["reports_per_month", 4, 5, "override"],
          ["seats", 1, 3, "default"],
        ]);
        await expect(storage.entitlements.list("ghost")).rejects.toMatchObject({ code: "entitlement_organization_unknown" });
      });

      it("consumos concurrentes nunca pasan del límite", async () => {
        const storage = await seed();
        await storage.entitlements.setLimit("org-1", "seats", 5);
        const results = await Promise.all(Array.from({ length: 20 }, () => storage.entitlements.consume("org-1", "seats")));
        expect(results.filter((result) => result.allowed)).toHaveLength(5);
        expect(await storage.entitlements.get("org-1", "seats")).toMatchObject({ used: 5, remaining: 0 });
        const mixed = await Promise.all([3, 3, 3, 3].map(() => storage.entitlements.consume("org-2", "seats", 2)));
        expect(mixed.filter((result) => result.allowed)).toHaveLength(1);
      });

      it("undefine borra la definición con sus límites y su uso", async () => {
        const storage = await seed();
        await storage.entitlements.setLimit("org-1", "seats", 9);
        await storage.entitlements.consume("org-1", "seats");
        await storage.entitlements.undefine("seats");
        expect(await storage.entitlements.findDefinition("seats")).toBeNull();
        await expect(storage.entitlements.get("org-1", "seats")).rejects.toMatchObject({ code: "entitlement_unknown" });
        await expect(storage.entitlements.undefine("seats")).rejects.toMatchObject({ code: "entitlement_unknown" });
        await storage.entitlements.define({ key: "seats", defaultLimit: 3 });
        expect(await storage.entitlements.get("org-1", "seats")).toMatchObject({ used: 0, limit: 3, source: "default" });
      });

      it("un storage auditado deja rastro de definir y cambiar límites, pero no de consumir", async () => {
        const raw = await seed();
        const audited = createAuditedStorage(raw, { actor: identity });
        await audited.entitlements.setLimit("org-1", "seats", 8);
        await audited.entitlements.clearLimit("org-1", "seats");
        await audited.entitlements.consume("org-1", "seats");
        const entries = await raw.auditLogs.search({ actionPrefix: "entitlement." });
        expect(entries.map((entry) => entry.action).sort()).toEqual(["entitlement.limit_changed", "entitlement.limit_cleared"]);
        expect(entries.find((entry) => entry.action === "entitlement.limit_changed")?.metadata).toEqual({ from: 3, to: 8 });
      });
    });

    describe("support grants — acceso temporal de un operador que no es miembro", () => {
      const ops = { provider: "supabase", subject: "ops" };
      const other = { provider: "supabase", subject: "other-ops" };
      const staff = { provider: "supabase", subject: "staff" };
      // El reloj de la prueba: la expiración debe estar en el futuro real, así que se mide desde ahora.
      const inHours = (hours: number) => new Date(Date.now() + hours * 3600 * 1000);

      async function seed() {
        const storage = harness.storage();
        await createOrganizationWithOwner(storage, {
          organizationId: "org-1",
          organizationName: "Acme",
          ownerRoleId: "role-owner",
          membershipId: "m-owner",
          ownerIdentity: identity,
        });
        await storage.organizations.create({ id: "org-2", name: "Otra" });
        for (const key of ["reports.read", "reports.write", "billing.read"]) await storage.permissions.register({ key });
        await storage.permissions.register({ key: "reports.admin", implies: ["reports.write"] });
        await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
        return storage;
      }

      const grant = (storage: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) =>
        storage.supportGrants.create({
          id: "g1",
          organizationId: "org-1",
          operator: ops,
          grantedBy: identity,
          reason: "  Ticket 4821: el cliente no ve sus informes  ",
          permissions: ["reports.write", "reports.read", "reports.read"],
          expiresAt: inHours(2),
          ...overrides,
        });

      it("crea la concesión con permisos ordenados y sin duplicados, y la encuentra", async () => {
        const storage = await seed();
        const created = await grant(storage);
        expect(created).toMatchObject({
          id: "g1",
          organizationId: "org-1",
          operator: ops,
          grantedBy: identity,
          reason: "Ticket 4821: el cliente no ve sus informes",
          permissions: ["reports.read", "reports.write"],
        });
        expect(created.revokedAt).toBeUndefined();
        expect(await storage.supportGrants.findById("g1")).toMatchObject({ id: "g1", permissions: ["reports.read", "reports.write"] });
        expect(await storage.supportGrants.findById("nope")).toBeNull();
      });

      it("rechaza lo que no es válido: motivo, permisos, expiración, organización, id repetido", async () => {
        const storage = await seed();
        await expect(grant(storage, { reason: "  " })).rejects.toMatchObject({ code: "support_grant_reason_invalid" });
        await expect(grant(storage, { reason: "x".repeat(501) })).rejects.toMatchObject({ code: "support_grant_reason_invalid" });
        await expect(grant(storage, { permissions: [] })).rejects.toMatchObject({ code: "support_grant_permission_invalid" });
        await expect(grant(storage, { permissions: ["not a key"] })).rejects.toMatchObject({ code: "support_grant_permission_invalid" });
        await expect(grant(storage, { permissions: ["reports.read", "never.registered"] })).rejects.toMatchObject({ code: "support_grant_permission_invalid" });
        await expect(grant(storage, { expiresAt: inHours(-1) })).rejects.toMatchObject({ code: "support_grant_expiry_invalid" });
        await expect(grant(storage, { expiresAt: inHours(31 * 24) })).rejects.toMatchObject({ code: "support_grant_expiry_invalid" });
        await expect(grant(storage, { expiresAt: new Date("nope") })).rejects.toMatchObject({ code: "support_grant_expiry_invalid" });
        await expect(grant(storage, { organizationId: "ghost" })).rejects.toMatchObject({ code: "support_grant_organization_unknown" });
        await grant(storage);
        await expect(grant(storage)).rejects.toMatchObject({ code: "support_grant_exists" });
        expect(await storage.supportGrants.count()).toBe(1);
      });

      it("el operador sin membresía puede lo que la concesión dice (y lo que implica), nada más, y solo en esa organización", async () => {
        const storage = await seed();
        const engine = createAuthorizationEngine(storage);
        const can = (who: typeof ops, organizationId: string, permission: string) => engine.can({ identity: who, organizationId, permission });
        expect(await can(ops, "org-1", "reports.read")).toBe(false);
        await grant(storage, { permissions: ["reports.admin"] });
        expect(await can(ops, "org-1", "reports.admin")).toBe(true);
        expect(await can(ops, "org-1", "reports.write")).toBe(true);
        expect(await can(ops, "org-1", "reports.read")).toBe(false);
        expect(await can(ops, "org-1", "billing.read")).toBe(false);
        expect(await can(ops, "org-1", "anything.at_all")).toBe(false);
        expect(await can(ops, "org-2", "reports.admin")).toBe(false);
        expect(await can(other, "org-1", "reports.admin")).toBe(false);
        expect(await engine.access.check({ identity: ops, organizationId: "org-1" })).toBe(true);
        expect(await engine.access.check({ identity: ops, organizationId: "org-1", feature: "agenda" })).toBe(true);
        expect(await engine.access.check({ identity: ops, organizationId: "org-1", permission: "reports.write", feature: "agenda" })).toBe(true);
        expect(await engine.access.check({ identity: ops, organizationId: "org-2" })).toBe(false);
        expect(await engine.access.check({ identity: other, organizationId: "org-1" })).toBe(false);
      });

      it("deja de valer al revocarla (idempotente), al expirar, y no sobrevive a una organización suspendida", async () => {
        const storage = await seed();
        const engine = createAuthorizationEngine(storage);
        const can = () => engine.can({ identity: ops, organizationId: "org-1", permission: "reports.read" });
        await grant(storage, { id: "g-short", expiresAt: new Date(Date.now() + 400) });
        await grant(storage);
        expect(await can()).toBe(true);
        await storage.organizations.setStatus("org-1", { status: "suspended", actor: identity });
        expect(await can()).toBe(false);
        expect(await engine.access.check({ identity: ops, organizationId: "org-1" })).toBe(false);
        await storage.organizations.setStatus("org-1", { status: "active", actor: identity });
        expect(await can()).toBe(true);

        const revoked = await storage.supportGrants.revoke("g1", { by: identity });
        expect(revoked).toMatchObject({ id: "g1", revokedBy: identity });
        expect(revoked?.revokedAt).toBeInstanceOf(Date);
        const again = await storage.supportGrants.revoke("g1", { by: staff });
        expect(again?.revokedBy).toEqual(identity);
        expect(await storage.supportGrants.revoke("nope", { by: identity })).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 450));
        expect(await can()).toBe(false);
      });

      it("un miembro bloqueado no se salta el bloqueo con una concesión; un miembro normal suma lo suyo y lo concedido", async () => {
        const storage = await seed();
        await storage.roles.create({ id: "r-staff", organizationId: "org-1", name: "Staff", permissionKeys: ["reports.read"] });
        await storage.memberships.create({ id: "m-staff", organizationId: "org-1", identity: staff, roleIds: ["r-staff"] });
        await grant(storage, { id: "g-staff", operator: staff, permissions: ["billing.read"] });
        const engine = createAuthorizationEngine(storage);
        const can = (permission: string) => engine.can({ identity: staff, organizationId: "org-1", permission });
        expect(await can("reports.read")).toBe(true);
        expect(await can("billing.read")).toBe(true);
        await storage.memberships.block("m-staff", { actor: identity, reason: "test" });
        expect(await can("reports.read")).toBe(false);
        expect(await can("billing.read")).toBe(false);
        expect(await engine.access.check({ identity: staff, organizationId: "org-1" })).toBe(false);
      });

      it("search y count filtran por organización, operador y estado, con cursor por id", async () => {
        const storage = await seed();
        await grant(storage, { id: "g1" });
        await grant(storage, { id: "g2", operator: other });
        await grant(storage, { id: "g3", organizationId: "org-2" });
        await grant(storage, { id: "g4", expiresAt: new Date(Date.now() + 300) });
        await storage.supportGrants.revoke("g2", { by: identity });
        await new Promise((resolve) => setTimeout(resolve, 350));
        const ids = async (options: Record<string, unknown>) => (await storage.supportGrants.search(options)).map((entry) => entry.id);
        expect(await ids({})).toEqual(["g1", "g2", "g3", "g4"]);
        expect(await ids({ organizationId: "org-2" })).toEqual(["g3"]);
        expect(await ids({ operator: other })).toEqual(["g2"]);
        expect(await ids({ status: "active" })).toEqual(["g1", "g3"]);
        expect(await ids({ status: "expired" })).toEqual(["g4"]);
        expect(await ids({ status: "revoked" })).toEqual(["g2"]);
        expect(await ids({ limit: 2 })).toEqual(["g1", "g2"]);
        expect(await ids({ limit: 2, after: "g2" })).toEqual(["g3", "g4"]);
        expect(await storage.supportGrants.count({ status: "active", organizationId: "org-1" })).toBe(1);
      });

      it("activePermissions une las concesiones activas de las identidades dadas en esa organización", async () => {
        const storage = await seed();
        await grant(storage, { id: "g1", permissions: ["reports.read"] });
        await grant(storage, { id: "g2", operator: other, permissions: ["billing.read"] });
        await grant(storage, { id: "g3", organizationId: "org-2", permissions: ["reports.write"] });
        const { supportGrants } = storage;
        expect(await supportGrants.activePermissions("org-1", [ops])).toEqual(["reports.read"]);
        expect(await supportGrants.activePermissions("org-1", [ops, other])).toEqual(["billing.read", "reports.read"]);
        expect(await supportGrants.activePermissions("org-1", [staff])).toEqual([]);
        expect(await supportGrants.activePermissions("org-1", [])).toEqual([]);
        expect(await supportGrants.activePermissions("org-1", [ops], new Date(Date.now() + 3 * 3600 * 1000))).toEqual([]);
      });

      it("una identidad enlazada usa la concesión de su identidad destino", async () => {
        const storage = await seed();
        const alias = { provider: "clerk", subject: "ops-alias" };
        await storage.identityLinks.link({ from: alias, to: ops, actor: identity });
        await grant(storage, { permissions: ["reports.read"] });
        const engine = createAuthorizationEngine(storage);
        expect(await engine.can({ identity: alias, organizationId: "org-1", permission: "reports.read" })).toBe(true);
      });

      it("un storage auditado deja rastro al crear y al revocar (una sola vez)", async () => {
        const raw = await seed();
        const audited = createAuditedStorage(raw, { actor: identity });
        await audited.supportGrants.create({
          id: "g-a", organizationId: "org-1", operator: ops, grantedBy: identity, reason: "ticket 7", permissions: ["reports.read"], expiresAt: inHours(1),
        });
        await audited.supportGrants.revoke("g-a", { by: identity });
        await audited.supportGrants.revoke("g-a", { by: identity });
        const entries = await raw.auditLogs.search({ actionPrefix: "support_grant." });
        expect(entries.map((entry) => entry.action).sort()).toEqual(["support_grant.created", "support_grant.revoked"]);
        expect(entries.find((entry) => entry.action === "support_grant.created")?.metadata).toMatchObject({ operator: ops, permissions: ["reports.read"], reason: "ticket 7" });
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
      expect(summaries).toEqual([{ id: "r1", organizationId: "o1", name: "Editor", key: "editor", isOwnerRole: false, isSystem: false }]);
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

      it("counts and searches by e-mail substring (case-insensitive, wildcards literal), combined with status", async () => {
        const storage = await seed();
        const emails = ["ana@example.com", "anabel@corp.io", "bob_x@example.com", "bobyx@example.com"];
        for (const [n, email] of emails.entries()) {
          await storage.invitations.create(base({ id: `inv-${n}`, tokenHash: `h${n}`, email, createdAt: new Date(Date.UTC(2026, 0, n + 1)) }));
        }
        await storage.invitations.revoke("inv-1", new Date());
        expect(await storage.invitations.count("org-1")).toBe(4);
        expect(await storage.invitations.count("org-1", { status: "revoked" })).toBe(1);
        expect(await storage.invitations.count("org-1", { query: "ANA" })).toBe(2);
        expect(await storage.invitations.count("org-1", { query: "ana", status: "pending" })).toBe(1);
        expect(await storage.invitations.count("org-1", { query: "_x@" })).toBe(1); // "_" is not a wildcard
        expect(await storage.invitations.count("org-1", { query: "%" })).toBe(0);
        expect(await storage.invitations.count("org-1", { query: "   " })).toBe(4);
        expect(await storage.invitations.count("other")).toBe(0);
        expect((await storage.invitations.search("org-1", { query: "example.com", limit: 2 })).map((i) => i.id)).toEqual(["inv-3", "inv-2"]);
        expect((await storage.invitations.search("org-1", { query: "ana" })).map((i) => i.id)).toEqual(["inv-1", "inv-0"]);
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
