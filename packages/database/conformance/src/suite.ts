import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAuthorizationEngine,
  createOrganizationWithOwner,
  FeatureError,
  IdentityLinkError,
  MembershipError,
  OrganizationError,
  PermissionError,
  RoleError,
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
      expect(catalog).toContainEqual({ key: "advanced_reports", name: "Advanced Reports v2", description: "..." });
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
  });
}
