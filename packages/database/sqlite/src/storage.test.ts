import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createTrustedTeamStorage } from "@uniora/core";
import { defineStorageConformance, type StorageHarness } from "@uniora/storage-conformance";
import { applyMigrations } from "./migrate.js";
import { AUDIT_APPEND_ONLY_TRIGGERS } from "./migrations/0003_audit_log_integrity.js";
import { AUDIT_CHECKPOINT_TRIGGERS } from "./migrations/0007_audit_log_retention.js";
import { createSqliteStorage } from "./storage.js";

const identity = { provider: "supabase", subject: "user-1" };

let db: Database.Database;

const harness: StorageHarness = {
  name: "@uniora/sqlite",
  async setup() {
    db = new Database(":memory:");
    applyMigrations(db);
  },
  async teardown() {
    db?.close();
  },
  async reset() {
    // Children before parents: cascades need `foreign_keys = on`, which the
    // storage enables, but a plain delete in dependency order never relies on it.
    db.exec(`
      delete from uniora_team_membership_roles;
      delete from uniora_team_memberships;
      delete from uniora_teams;
      delete from uniora_outbox;
      delete from uniora_support_grants;
      delete from uniora_entitlement_usage;
      delete from uniora_entitlement_limits;
      delete from uniora_entitlement_definitions;
      delete from uniora_invitation_roles;
      delete from uniora_invitations;
      delete from uniora_membership_roles;
      delete from uniora_role_permissions;
      delete from uniora_memberships;
      delete from uniora_roles;
      delete from uniora_features;
      update uniora_feature_definitions set parent_key = null;
      delete from uniora_feature_definitions;
      delete from uniora_permission_implications;
      delete from uniora_permissions;
      drop trigger if exists uniora_audit_logs_no_delete;
      drop trigger if exists uniora_audit_log_checkpoints_no_delete;
      delete from uniora_audit_log_checkpoints;
      delete from uniora_audit_logs;
      delete from uniora_identity_links;
      delete from uniora_organizations;
    `);
    db.exec(AUDIT_APPEND_ONLY_TRIGGERS);
    db.exec(AUDIT_CHECKPOINT_TRIGGERS);
  },
  storage: () => createSqliteStorage(db),
  probe: {
    async forgeMembershipRole(membershipId, roleId) {
      db.prepare("insert into uniora_membership_roles (membership_id, role_id) values (?, ?)").run(membershipId, roleId);
    },
    async hasMembershipRole(membershipId, roleId) {
      return db.prepare("select 1 from uniora_membership_roles where membership_id = ? and role_id = ?").get(membershipId, roleId) !== undefined;
    },
    async countIdentityLinks() {
      return (db.prepare("select count(*) as count from uniora_identity_links").get() as { count: number }).count;
    },
    async attemptAuditUpdate(id) {
      try {
        db.prepare("update uniora_audit_logs set action = 'x' where id = ?").run(id);
        return "applied";
      } catch {
        return "rejected";
      }
    },
    async attemptAuditDelete(id) {
      try {
        db.prepare("delete from uniora_audit_logs where id = ?").run(id);
        return "applied";
      } catch {
        return "rejected";
      }
    },
    async tamperAuditAction(id, action) {
      db.exec("drop trigger uniora_audit_logs_no_update");
      db.prepare("update uniora_audit_logs set action = ? where id = ?").run(action, id);
      db.exec(AUDIT_APPEND_ONLY_TRIGGERS);
    },
    async tamperAuditDelete(id) {
      db.exec("drop trigger uniora_audit_logs_no_delete");
      db.prepare("delete from uniora_audit_logs where id = ?").run(id);
      db.exec(AUDIT_APPEND_ONLY_TRIGGERS);
    },
    async countAuditEntries(action) {
      return (db.prepare("select count(*) as count from uniora_audit_logs where action = ?").get(action) as { count: number }).count;
    },
  },
  policyProbe: {
    updateRevisionDirectly: async (policyId, revision) => attempt("update uniora_policy_revisions set note = 'tampered' where policy_id = ? and revision = ?", policyId, revision),
    deleteRevisionDirectly: async (policyId, revision) => attempt("delete from uniora_policy_revisions where policy_id = ? and revision = ?", policyId, revision),
    reviveRetiredDirectly: async (policyId) => attempt("update uniora_policies set status = 'active', version = version + 1 where id = ?", policyId),
    deleteDirectly: async (policyId) => attempt("delete from uniora_policies where id = ?", policyId),
    attachRevisionOfOtherOrganizationDirectly: async (policyId, organizationId) =>
      attempt(
        `insert into uniora_policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject)
         select id, ?, 99, definition, definition_hash, '2026-01-01T00:00:00.000Z', 'p', 's' from uniora_policies where id = ?`,
        organizationId,
        policyId,
      ),
    moveToOtherOrganizationDirectly: async (policyId, organizationId) =>
      attempt("update uniora_policies set organization_id = ?, version = version + 1 where id = ?", organizationId, policyId),
    changeHashDirectly: async (policyId) => attempt("update uniora_policies set definition_hash = ?, version = version + 1 where id = ?", "f".repeat(64), policyId),
    changeDefinitionDirectly: async (policyId) => attempt("update uniora_policies set definition = json_set(definition, '$.extra', json('true')), version = version + 1 where id = ?", policyId),
    skipVersionDirectly: async (policyId) => attempt("update uniora_policies set name = 'renamed' where id = ?", policyId),
    insertWithoutRevisionDirectly: async (organizationId, id) =>
      attempt(
        `insert into uniora_policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at)
         values (?1, ?2, ?1, 'orphan', 'access', 'deny', '{"kind":"access","effect":"deny"}', ?3, '2026-01-01T00:00:00.000Z', 'p', 's', '2026-01-01T00:00:00.000Z')`,
        id,
        organizationId,
        "a".repeat(64),
      ),
    async fillDraftsDirectly(organizationId, total) {
      const definition = `'{"kind":"access","effect":"deny","actions":["reports.run"],"condition":{"not":{"exists":"subject.teamIds"}}}'`;
      const hash = "a".repeat(64);
      db.exec("begin");
      try {
        db.prepare(
          `with recursive n(i) as (select 0 union all select i + 1 from n where i < ${Number(total)} - 1)
           insert into uniora_policies (id, organization_id, key, name, kind, effect, definition, definition_hash, created_at, created_by_provider, created_by_subject, updated_at)
           select 'fill-' || printf('%04d', i), ?, 'fill-' || printf('%04d', i), 'fill', 'access', 'deny', ${definition}, '${hash}', '2026-01-01T00:00:00.000Z', 'p', 's', '2026-01-01T00:00:00.000Z' from n`,
        ).run(organizationId);
        db.prepare(
          `with recursive n(i) as (select 0 union all select i + 1 from n where i < ${Number(total)} - 1)
           insert into uniora_policy_revisions (policy_id, organization_id, revision, definition, definition_hash, created_at, created_by_provider, created_by_subject)
           select 'fill-' || printf('%04d', i), ?, 1, ${definition}, '${hash}', '2026-01-01T00:00:00.000Z', 'p', 's' from n`,
        ).run(organizationId);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    deleteOrganizationDirectly: async (organizationId) => attempt("delete from uniora_organizations where id = ?", organizationId),
    async countRows(organizationId) {
      const count = (table: string) => (db.prepare(`select count(*) as n from ${table} where organization_id = ?`).get(organizationId) as { n: number }).n;
      return { policies: count("uniora_policies"), revisions: count("uniora_policy_revisions"), counters: count("uniora_policy_set_revisions") };
    },
  },
};

/** Runs a statement as any client could; `"rejected"` when the database refuses it. */
function attempt(sql: string, ...params: unknown[]): "rejected" | "applied" {
  try {
    db.prepare(sql).run(...params);
    return "applied";
  } catch {
    return "rejected";
  }
}

defineStorageConformance(harness, () => {
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
      db
        .prepare(`insert into uniora_team_memberships (id, organization_id, team_id, membership_id, status, created_at, updated_at) values (?, ?, ?, ?, 'active', 'now', 'now')`)
        .run(id, org, team, member);
    expect(() => insert("x1", "org-b", "team-b", "m-a")).toThrow();
    expect(() => insert("x2", "org-a", "team-b", "m-a")).toThrow();
    expect(() => insert("x3", "org-a", "team-a", "m-b")).toThrow();
    insert("ok", "org-a", "team-a", "m-a");
    expect(() => db.prepare(`insert into uniora_team_membership_roles (team_membership_id, role_id, organization_id) values ('ok', 'role-b', 'org-a')`).run()).toThrow();
    expect(() => db.prepare(`insert into uniora_team_membership_roles (team_membership_id, role_id, organization_id) values ('ok', 'role-b', 'org-b')`).run()).toThrow();
    expect(() => db.prepare(`update uniora_team_memberships set team_id = 'team-b' where id = 'ok'`).run()).toThrow();
    expect(() => db.prepare(`update uniora_team_memberships set organization_id = 'org-b' where id = 'ok'`).run()).toThrow();
  });
});
