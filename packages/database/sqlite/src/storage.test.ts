import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { defineStorageConformance, type StorageHarness } from "@uniora/storage-conformance";
import { applyMigrations } from "./migrate.js";
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
      delete from uniora_invitation_roles;
      delete from uniora_invitations;
      delete from uniora_membership_roles;
      delete from uniora_role_permissions;
      delete from uniora_memberships;
      delete from uniora_roles;
      delete from uniora_features;
      delete from uniora_feature_definitions;
      delete from uniora_permissions;
      delete from uniora_audit_logs;
      delete from uniora_identity_links;
      delete from uniora_organizations;
    `);
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
    async countAuditEntries(action) {
      return (db.prepare("select count(*) as count from uniora_audit_logs where action = ?").get(action) as { count: number }).count;
    },
  },
};

defineStorageConformance(harness);
