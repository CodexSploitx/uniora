import {
  type AuthorizationEngine,
  type UnioraStorage,
  IdentityLinkError,
  MembershipError,
  computeAuthorizationSnapshot,
  createAuthorizationEngine,
  createOrganizationWithOwner,
} from "@uniora/core";
import { applyMigrations, createPostgresStorage } from "@uniora/postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eDatabaseUrl, resetUnioraSchema } from "./test-database.js";

/**
 * Prueba de integración end-to-end: ejercita el stack real
 * (`@uniora/core` + `@uniora/postgres`, código fuente del monorepo vía
 * `workspace:*`) contra un Postgres real — migraciones reales, transacciones
 * reales, el `AuthorizationEngine` real. No es una repetición de las suites
 * unitarias de cada paquete (esas ya cubren cada método exhaustivamente);
 * esto es "¿el flujo completo, de punta a punta, realmente funciona?" —
 * incluyendo los invariantes de seguridad centrales del proyecto (ver
 * `docs/PROYECT.md` §33 y la skill `uniora-security-engineering`).
 *
 * Corre sobre su propia base de datos (`uniora_test_e2e`, derivada de
 * `TEST_DATABASE_URL`) — nunca toca `DATABASE_URL` (datos de demo/dev) ni
 * `uniora_test` (la suite unitaria de `@uniora/postgres`). Se salta
 * completa si `TEST_DATABASE_URL` no está configurada, en vez de fallar —
 * mismo criterio que el resto del monorepo: nunca inventa un valor por
 * defecto.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("UNIORA end-to-end (Postgres real)", () => {
  let pool: pg.Pool;
  let storage: UnioraStorage;
  let engine: AuthorizationEngine;

  const ownerAIdentity = { provider: "e2e", subject: "owner-a" };
  const salesAIdentity = { provider: "e2e", subject: "sales-a" };
  const ownerBIdentity = { provider: "e2e", subject: "owner-b" };

  let organizationAId: string;
  let organizationBId: string;
  const salesRoleAId = "role-sales-a";
  const ownerRoleAId = "role-owner-a";
  const ownerMembershipAId = "membership-owner-a";

  beforeAll(async () => {
    await resetUnioraSchema();
    pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
    await applyMigrations(pool);
    storage = createPostgresStorage(pool);
    engine = createAuthorizationEngine(storage);

    await storage.permissions.register({ key: "vehicles.read", name: "Ver vehículos" });
    await storage.permissions.register({ key: "vehicles.delete", name: "Eliminar vehículos" });
    await storage.features.register({ key: "ai_assistant", name: "Asistente IA" });

    const { organization: organizationA } = await createOrganizationWithOwner(storage, {
      organizationId: "org-a",
      organizationName: "Acme A",
      ownerRoleId: ownerRoleAId,
      membershipId: ownerMembershipAId,
      ownerIdentity: ownerAIdentity,
    });
    organizationAId = organizationA.id;

    const { organization: organizationB } = await createOrganizationWithOwner(storage, {
      organizationId: "org-b",
      organizationName: "Acme B",
      ownerRoleId: "role-owner-b",
      membershipId: "membership-owner-b",
      ownerIdentity: ownerBIdentity,
    });
    organizationBId = organizationB.id;

    await storage.roles.create({
      id: salesRoleAId,
      organizationId: organizationAId,
      name: "Sales",
      permissionKeys: ["vehicles.read"],
    });

    await storage.memberships.create({
      id: "membership-sales-a",
      organizationId: organizationAId,
      identity: salesAIdentity,
      roleIds: [salesRoleAId],
    });

    await storage.features.enable(organizationAId, "ai_assistant");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("el Owner obtiene cualquier permiso sin importar permissionKeys (bypass real, §11 Owner Protection)", async () => {
    const granted = await engine.can({
      identity: ownerAIdentity,
      organizationId: organizationAId,
      permission: "vehicles.delete",
    });
    expect(granted).toBe(true);
  });

  it("un rol custom solo obtiene los permisos explícitamente concedidos (INV-003 — no hay implicación entre permisos)", async () => {
    const canRead = await engine.can({
      identity: salesAIdentity,
      organizationId: organizationAId,
      permission: "vehicles.read",
    });
    const canDelete = await engine.can({
      identity: salesAIdentity,
      organizationId: organizationAId,
      permission: "vehicles.delete",
    });
    expect(canRead).toBe(true);
    expect(canDelete).toBe(false);
  });

  it("un permiso desconocido nunca se interpreta como acceso sin restricción (INV-005)", async () => {
    const granted = await engine.can({
      identity: salesAIdentity,
      organizationId: organizationAId,
      permission: "vehicles.teleport",
    });
    expect(granted).toBe(false);
  });

  it("una identidad sin membership en la organización nunca obtiene acceso, sin importar quién sea en otra org (INV-001/INV-002)", async () => {
    const ownerOfAInB = await engine.can({
      identity: ownerAIdentity,
      organizationId: organizationBId,
      permission: "vehicles.read",
    });
    const salesOfAInB = await engine.can({
      identity: salesAIdentity,
      organizationId: organizationBId,
      permission: "vehicles.read",
    });
    expect(ownerOfAInB).toBe(false);
    expect(salesOfAInB).toBe(false);
  });

  it("nunca confía en un role de otra organización, aunque el membership lo referencie directamente", async () => {
    // Esto ya no ocurre a través de la API pública: `MembershipRepository
    // .create`/`assignRole` rechazan un roleId de otra organización desde
    // el origen (docs/security-pentest-2026-09-24.md Hallazgo 2). Pero el
    // motor debe defenderse igual si el dato llegara a existir por otra
    // vía (corrupción, migración manual, un bug futuro) — es exactamente
    // el escenario que documenta el comentario de
    // `createAuthorizationEngine`: "Roles from another organization are
    // never trusted, even if their id were guessable." Se simula insertando
    // la fila directamente contra Postgres, saltándose la API guardada a
    // propósito, en vez de a través de `create()`/`assignRole()`.
    const attackerIdentity = { provider: "e2e", subject: "attacker-b" };
    await storage.memberships.create({
      id: "membership-attacker-b",
      organizationId: organizationBId,
      identity: attackerIdentity,
    });
    await pool.query(`insert into uniora.membership_roles (membership_id, role_id) values ($1, $2)`, [
      "membership-attacker-b",
      salesRoleAId,
    ]);

    const granted = await engine.can({
      identity: attackerIdentity,
      organizationId: organizationBId,
      permission: "vehicles.read",
    });
    expect(granted).toBe(false);
  });

  it("las features están aisladas por organización y un feature nunca registrado deniega (INV-007)", async () => {
    const enabledInA = await engine.access.check({
      identity: salesAIdentity,
      organizationId: organizationAId,
      feature: "ai_assistant",
    });
    const enabledInB = await engine.access.check({
      identity: ownerBIdentity,
      organizationId: organizationBId,
      feature: "ai_assistant",
    });
    const neverRegistered = await engine.access.check({
      identity: salesAIdentity,
      organizationId: organizationAId,
      feature: "never_registered",
    });
    expect(enabledInA).toBe(true);
    expect(enabledInB).toBe(false);
    expect(neverRegistered).toBe(false);
  });

  it("access.check() sin permission ni feature igual exige membership real (regresión — docs/security-pentest-2026-09-24.md Hallazgo 1)", async () => {
    const attacker = { provider: "e2e", subject: "nobody-attacker" };

    const attackerInA = await engine.access.check({ identity: attacker, organizationId: organizationAId });
    const ownerBInA = await engine.access.check({ identity: ownerBIdentity, organizationId: organizationAId });
    const salesAInA = await engine.access.check({ identity: salesAIdentity, organizationId: organizationAId });

    expect(attackerInA).toBe(false);
    expect(ownerBInA).toBe(false);
    expect(salesAInA).toBe(true);
  });

  it("access.check({ feature }) sin permission igual exige membership real, aunque el feature esté habilitado (regresión — docs/security-pentest-2026-09-24.md Hallazgo 4)", async () => {
    const attacker = { provider: "e2e", subject: "nobody-attacker-2" };

    // "ai_assistant" está habilitado en organizationA desde beforeAll — ni el
    // atacante inventado ni el Owner legítimo de B tienen membership ahí.
    const attackerInA = await engine.access.check({ identity: attacker, organizationId: organizationAId, feature: "ai_assistant" });
    const ownerBInA = await engine.access.check({ identity: ownerBIdentity, organizationId: organizationAId, feature: "ai_assistant" });
    const salesAInA = await engine.access.check({ identity: salesAIdentity, organizationId: organizationAId, feature: "ai_assistant" });

    expect(attackerInA).toBe(false);
    expect(ownerBInA).toBe(false);
    expect(salesAInA).toBe(true);
  });

  it("computeAuthorizationSnapshot resuelve exactamente el conjunto pedido — nunca 'todo lo que la identidad puede hacer'", async () => {
    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity: salesAIdentity,
      organizationId: organizationAId,
      permissions: ["vehicles.read", "vehicles.delete"],
      features: ["ai_assistant"],
    });
    expect(snapshot).toEqual({
      organizationId: organizationAId,
      permissions: { "vehicles.read": true, "vehicles.delete": false },
      features: { ai_assistant: true },
    });
  });

  describe("protección del último Owner (§11 Owner Protection)", () => {
    it("rechaza quitar el rol de Owner o borrar el membership cuando es el único Owner", async () => {
      await expect(storage.memberships.unassignOwnerRole(ownerMembershipAId, ownerRoleAId)).rejects.toThrow(
        MembershipError,
      );
      await expect(storage.memberships.delete(ownerMembershipAId)).rejects.toThrow(MembershipError);
    });

    it("permite quitar un Owner cuando hay al menos otro más (multi-owner), pero no el último que queda", async () => {
      const secondOwnerIdentity = { provider: "e2e", subject: "owner-a-2" };
      await storage.memberships.create({
        id: "membership-owner-a-2",
        organizationId: organizationAId,
        identity: secondOwnerIdentity,
        roleIds: [ownerRoleAId],
      });

      // Ahora hay dos Owners: quitarle el rol al primero es válido.
      await expect(storage.memberships.unassignOwnerRole(ownerMembershipAId, ownerRoleAId)).resolves.toBeUndefined();
      // Pero el segundo (ahora el único) sigue protegido.
      await expect(
        storage.memberships.unassignOwnerRole("membership-owner-a-2", ownerRoleAId),
      ).rejects.toThrow(MembershipError);

      // Deja el estado como estaba, por si el archivo se re-corre sin reset.
      await storage.memberships.assignOwnerRole(ownerMembershipAId, ownerRoleAId);
    });

    it("assignRole()/unassignRole() genéricos rechazan tocar el role Owner (regresión — docs/security-pentest-2026-09-24.md Hallazgo 7)", async () => {
      await expect(storage.memberships.assignRole(ownerMembershipAId, ownerRoleAId)).rejects.toThrow(MembershipError);
      await expect(storage.memberships.unassignRole(ownerMembershipAId, ownerRoleAId)).rejects.toThrow(MembershipError);
    });
  });

  describe("IdentityLink: auditoría real y 'no chains' simétrico (regresión — docs/security-pentest-2026-09-24.md Hallazgo 5/6)", () => {
    it("link() escribe una entrada global de audit log usando 'actor' (Hallazgo 5)", async () => {
      const before = await storage.auditLogs.listRecent({ limit: 200 });
      const from = { provider: "e2e", subject: "link-audit-from" };
      const to = { provider: "e2e", subject: "link-audit-to" };

      await storage.identityLinks.link({ from, to, actor: to });

      const after = await storage.auditLogs.listRecent({ limit: 200 });
      expect(after.length).toBe(before.length + 1);
      const entry = after.find((e) => e.action === "identity_link.created" && e.target?.id === `${from.provider}:${from.subject}`);
      expect(entry).toBeDefined();
      expect(entry?.organizationId).toBeUndefined(); // entrada global, no pertenece a ninguna organización
      expect(entry?.actor).toEqual(to);
      expect(entry?.metadata).toEqual({ from, to });

      // Un re-link idempotente (mismo from/to) no debe duplicar la entrada.
      await storage.identityLinks.link({ from, to, actor: to });
      const afterIdempotent = await storage.auditLogs.listRecent({ limit: 200 });
      expect(afterIdempotent.length).toBe(after.length);
    });

    it("rechaza construir una cadena de 2 hops por orden de creación (A->B, luego B->C) (Hallazgo 6)", async () => {
      const identityA = { provider: "e2e", subject: "chain-a" };
      const identityB = { provider: "e2e", subject: "chain-b" };
      const identityC = { provider: "e2e", subject: "chain-c" };

      await storage.identityLinks.link({ from: identityA, to: identityB, actor: identityB });
      await expect(storage.identityLinks.link({ from: identityB, to: identityC, actor: identityC })).rejects.toThrow(
        IdentityLinkError,
      );
    });
  });
});
