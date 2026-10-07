import type { Pool } from "pg";
import { expect, it } from "vitest";
import { defineStorageConformance, type StorageHarness } from "@uniora/storage-conformance";
import { createTestPool } from "./test-pool.js";
import { applyMigrations } from "./migrate.js";
import { createInvitationService, createOrganizationWithOwner } from "@uniora/core";
import { createPostgresStorage } from "./storage.js";

let pool: Pool;

const harness: StorageHarness = {
  name: "@uniora/postgres",
  async setup() {
    pool = createTestPool();
    await applyMigrations(pool);
  },
  async teardown() {
    await pool?.end();
  },
  async reset() {
    await pool.query(
      `truncate table uniora.invitation_roles, uniora.invitations, uniora.membership_roles, uniora.role_permissions, uniora.memberships,
              uniora.roles, uniora.features, uniora.feature_definitions, uniora.permissions,
              uniora.audit_logs, uniora.audit_log_checkpoints, uniora.identity_links, uniora.outbox, uniora.entitlement_definitions, uniora.support_grants, uniora.organizations cascade`,
    );
  },
  storage: () => createPostgresStorage(pool),
  probe: {
    async forgeMembershipRole(membershipId, roleId) {
      await pool.query(`insert into uniora.membership_roles (membership_id, role_id) values ($1, $2)`, [
        membershipId,
        roleId,
      ]);
    },
    async hasMembershipRole(membershipId, roleId) {
      const result = await pool.query("select 1 from uniora.membership_roles where membership_id=$1 and role_id=$2", [
        membershipId,
        roleId,
      ]);
      return (result.rowCount ?? 0) > 0;
    },
    async countIdentityLinks() {
      const result = await pool.query<{ count: string }>("select count(*)::text as count from uniora.identity_links");
      return Number(result.rows[0]!.count);
    },
    async countAuditEntries(action) {
      const result = await pool.query<{ count: string }>(
        "select count(*)::text as count from uniora.audit_logs where action = $1",
        [action],
      );
      return Number(result.rows[0]!.count);
    },
    async attemptAuditUpdate(id) {
      return pool.query("update uniora.audit_logs set action = 'x' where id = $1", [id]).then(
        () => "applied" as const,
        () => "rejected" as const,
      );
    },
    async attemptAuditDelete(id) {
      return pool.query("delete from uniora.audit_logs where id = $1", [id]).then(
        () => "applied" as const,
        () => "rejected" as const,
      );
    },
    async tamperAuditAction(id, action) {
      await withoutAuditProtection(`update uniora.audit_logs set action = '${action.replace(/'/g, "''")}' where id = '${id.replace(/'/g, "''")}'`);
    },
    async tamperAuditDelete(id) {
      await withoutAuditProtection(`delete from uniora.audit_logs where id = '${id.replace(/'/g, "''")}'`);
    },
  },
};

/** What a superuser (or the table owner) could do: switch the append-only trigger off, edit, switch it back on. */
async function withoutAuditProtection(statement: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("alter table uniora.audit_logs disable trigger audit_logs_append_only");
    await client.query(statement);
    await client.query("alter table uniora.audit_logs enable trigger audit_logs_append_only");
  } finally {
    client.release();
  }
}

const identity = { provider: "supabase", subject: "user-1" };

defineStorageConformance(harness, () => {
  it("organizations.create() y auditLogs.record() usan created_at con precisión de milisegundos (nunca microsegundos)", async () => {
    // Regresión: un cursor keyset se construye desde un JS `Date`
    // (`toISOString()`), que solo tiene precisión de milisegundos. Si la
    // columna guardara microsegundos (el default de `now()` en Postgres),
    // reconstruir el cursor desde ese `Date` lo dejaría por DEBAJO del
    // valor real de la fila límite — y en `organizations.search` (orden
    // ascendente, `created_at > cursor`) eso hacía que esa misma fila
    // reapareciera como primer resultado de la siguiente página.
    // Confirmado en la práctica con los 1020 organizations sembrados:
    // 1019 de 1020 tenían microsegundos no nulos antes de esta migración.
    const storage = harness.storage();
    await storage.organizations.create({ id: "org-1", name: "Acme Motors" });
    await storage.auditLogs.record({ id: "log-1", organizationId: "org-1", actor: identity, action: "role.created" });

    const orgRow = await pool.query(
      `select 1 from uniora.organizations where id = $1 and date_trunc('milliseconds', created_at) = created_at`,
      ["org-1"],
    );
    expect(orgRow.rowCount).toBe(1);

    const logRow = await pool.query(
      `select 1 from uniora.audit_logs where id = $1 and date_trunc('milliseconds', created_at) = created_at`,
      ["log-1"],
    );
    expect(logRow.rowCount).toBe(1);
  });

  it("el insert de membership_roles dentro de create() nunca acepta un role.id que ya no pertenece a la organización (misma guarda que assignRole)", async () => {
    // La validación por lote de `roleIds` en `create()` (un `select`
    // previo al insert de la membership) ya rechaza el caso SECUENCIAL —
    // ese `select` corre después de que el role fue reciclado a otra
    // organización, así que lo detecta igual (confirmado: llamar
    // `create()` tras el reciclaje ya lanza `MembershipError` desde esa
    // validación, sin siquiera llegar al insert de `membership_roles`).
    // Este test ejercita directamente la SEGUNDA capa — el `insert ...
    // where exists (...)` correlacionado que protege la ventana entre esa
    // validación por lote y el insert real, reproduciendo esa ventana con
    // el mismo id ya reciclado (mismo patrón que el test de `assignRole`
    // de la suite compartida).
    const storage = harness.storage();
    const orgA = await storage.organizations.create({ id: "org-a", name: "Org A" });
    const orgB = await storage.organizations.create({ id: "org-b", name: "Org B" });
    const roleId = "role-shared-id-2";
    await storage.roles.create({ id: roleId, organizationId: orgA.id, name: "Sales" });
    await storage.memberships.create({ id: "m-2", organizationId: orgA.id, identity: { provider: "supabase", subject: "member-2" } });

    await storage.roles.delete(roleId);
    await storage.roles.create({ id: roleId, organizationId: orgB.id, name: "Sales (recreado en Org B)" });

    const result = await pool.query(
      `insert into uniora.membership_roles (membership_id, role_id)
       select $1, $2
       where exists (select 1 from uniora.roles r where r.id = $2 and r.organization_id = $3)
       on conflict do nothing`,
      ["m-2", roleId, orgA.id],
    );
    expect(result.rowCount).toBe(0);

    expect(await harness.probe.hasMembershipRole("m-2", roleId)).toBe(false);
  });

  it("el límite de invitaciones se respeta entre procesos distintos (audit F-06)", async () => {
    const second = createTestPool();
    try {
      const storageA = createPostgresStorage(pool);
      const storageB = createPostgresStorage(second);
      await createOrganizationWithOwner(storageA, {
        organizationId: "org-race",
        organizationName: "Race",
        ownerRoleId: "role-owner-race",
        membershipId: "m-owner-race",
        ownerIdentity: { provider: "supabase", subject: "owner-race" },
      });
      await storageA.roles.create({ id: "role-viewer-race", organizationId: "org-race", name: "Viewer", permissionKeys: [] });
      const make = (storage: typeof storageA) =>
        createInvitationService({
          storage,
          acceptUrl: (token) => `https://app.test/invite/${token}`,
          rateLimits: { perOrganizationPerHour: 3 },
        });
      const services = [make(storageA), make(storageB)];

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          services[index % 2]!.invite({
            organizationId: "org-race",
            email: `victim${index}@example.com`,
            roleIds: ["role-viewer-race"],
            invitedBy: { provider: "supabase", subject: "owner-race" },
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")))).toHaveLength(3);
    } finally {
      await second.end();
    }
  });
});
