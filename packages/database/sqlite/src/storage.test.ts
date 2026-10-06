import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { defineStorageConformance, type StorageHarness } from "@uniora/storage-conformance";
import { applyMigrations } from "./migrate.js";
import { AUDIT_APPEND_ONLY_TRIGGERS } from "./migrations/0003_audit_log_integrity.js";
import { AUDIT_CHECKPOINT_TRIGGERS } from "./migrations/0007_audit_log_retention.js";
import { createSqliteStorage } from "./storage.js";

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
};

defineStorageConformance(harness);
