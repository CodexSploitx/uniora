import type { Pool } from "pg";
import { expect, it } from "vitest";
import { defineStorageConformance, type StorageHarness } from "@uniora/storage-conformance";
import { createTestPool } from "./test-pool.js";
import { applyMigrations } from "./migrate.js";
import { createInvitationService, createOrganizationWithOwner, createTrustedTeamStorage } from "@uniora/core";
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
  policyProbe: {
    updateRevisionDirectly: (policyId, revision) => attempt(`update uniora.policy_revisions set note = 'tampered' where policy_id = $1 and revision = $2`, [policyId, revision]),
    deleteRevisionDirectly: (policyId, revision) => attempt(`delete from uniora.policy_revisions where policy_id = $1 and revision = $2`, [policyId, revision]),
    reviveRetiredDirectly: (policyId) => attempt(`update uniora.policies set status = 'active', version = version + 1 where id = $1`, [policyId]),
    deleteDirectly: (policyId) => attempt(`delete from uniora.policies where id = $1`, [policyId]),
    attachRevisionOfOtherOrganizationDirectly: (policyId, organizationId) =>
      attempt(
        `insert into uniora.policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_by_provider, created_by_subject)
         select id, $2, 99, definition, definition_hash, 'p', 's' from uniora.policies where id = $1`,
        [policyId, organizationId],
      ),
    moveToOtherOrganizationDirectly: (policyId, organizationId) =>
      attempt(`update uniora.policies set organization_id = $2, version = version + 1 where id = $1`, [policyId, organizationId]),
    changeHashDirectly: (policyId) => attempt(`update uniora.policies set definition_hash = repeat('f', 64), version = version + 1 where id = $1`, [policyId]),
    changeDefinitionDirectly: (policyId) => attempt(`update uniora.policies set definition = definition || '{"extra": true}'::jsonb, version = version + 1 where id = $1`, [policyId]),
    skipVersionDirectly: (policyId) => attempt(`update uniora.policies set name = 'renamed' where id = $1`, [policyId]),
    insertWithoutRevisionDirectly: (organizationId, id) =>
      attempt(
        `insert into uniora.policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_by_provider, created_by_subject)
         values ($1, $2, $1, 'orphan', 'access', 'deny', '{"kind":"access","effect":"deny"}'::jsonb, repeat('a', 64), 'p', 's')`,
        [id, organizationId],
      ),
    async fillDraftsDirectly(organizationId, total) {
      const definition = `'{"kind":"access","effect":"deny","actions":["reports.run"],"condition":{"not":{"exists":"subject.teamIds"}}}'::jsonb`;
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into uniora.policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_by_provider, created_by_subject)
           select 'fill-' || lpad(i::text, 4, '0'), $1, 'fill-' || lpad(i::text, 4, '0'), 'fill', 'access', 'deny', ${definition}, repeat('a', 64), 'p', 's' from generate_series(0, $2::int - 1) i`,
          [organizationId, total],
        );
        await client.query(
          `insert into uniora.policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_by_provider, created_by_subject)
           select 'fill-' || lpad(i::text, 4, '0'), $1, 1, ${definition}, repeat('a', 64), 'p', 's' from generate_series(0, $2::int - 1) i`,
          [organizationId, total],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    deleteOrganizationDirectly: (organizationId) => attempt(`delete from uniora.organizations where id = $1`, [organizationId]),
    async countRows(organizationId) {
      const count = async (table: string) =>
        Number((await pool.query<{ n: string }>(`select count(*)::text as n from uniora.${table} where organization_id = $1`, [organizationId])).rows[0]!.n);
      return { policies: await count("policies"), revisions: await count("policy_revisions"), counters: await count("policy_set_revisions") };
    },
  },
};

/** Runs a statement as any client could; `"rejected"` when the database refuses it. */
function attempt(sql: string, params: unknown[]): Promise<"rejected" | "applied"> {
  return pool.query(sql, params).then(
    () => "applied" as const,
    () => "rejected" as const,
  );
}

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

  it("teams: la base de datos misma rechaza filas entre organizaciones, aunque alguien escriba SQL directo", async () => {
    const storage = createTrustedTeamStorage(harness.storage(), { actor: identity, reason: "adapter isolation test" });
    await storage.organizations.create({ id: "org-a", name: "A" });
    await storage.organizations.create({ id: "org-b", name: "B" });
    await storage.teams.create({ id: "team-a", organizationId: "org-a", name: "Equipo A" });
    await storage.teams.create({ id: "team-b", organizationId: "org-b", name: "Equipo B" });
    await storage.roles.create({ id: "role-b", organizationId: "org-b", name: "Rol B" });
    await storage.memberships.create({ id: "m-a", organizationId: "org-a", identity: { provider: "p", subject: "a" } });
    await storage.memberships.create({ id: "m-b", organizationId: "org-b", identity: { provider: "p", subject: "b" } });
    const insert = (id: string, org: string, team: string, member: string) =>
      pool.query(
        `insert into uniora.team_memberships (id, organization_id, team_id, membership_id, status) values ($1, $2, $3, $4, 'active')`,
        [id, org, team, member],
      );
    // El miembro de A en el equipo de B (con cualquiera de las dos organizaciones) y al revés.
    await expect(insert("x1", "org-b", "team-b", "m-a")).rejects.toThrow();
    await expect(insert("x2", "org-a", "team-b", "m-a")).rejects.toThrow();
    await expect(insert("x3", "org-a", "team-a", "m-b")).rejects.toThrow();
    await insert("ok", "org-a", "team-a", "m-a");
    // Un rol de otra organización tampoco puede colgarse de una membresía de equipo.
    await expect(
      pool.query(`insert into uniora.team_membership_roles (team_membership_id, role_id, organization_id) values ('ok', 'role-b', 'org-a')`),
    ).rejects.toThrow();
    await expect(
      pool.query(`insert into uniora.team_membership_roles (team_membership_id, role_id, organization_id) values ('ok', 'role-b', 'org-b')`),
    ).rejects.toThrow();
    // Mover una fila a otro equipo o a otra organización con un UPDATE directo también falla.
    await expect(pool.query(`update uniora.team_memberships set team_id = 'team-b' where id = 'ok'`)).rejects.toThrow();
    await expect(pool.query(`update uniora.team_memberships set organization_id = 'org-b' where id = 'ok'`)).rejects.toThrow();
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
