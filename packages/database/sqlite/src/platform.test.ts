import Database from "better-sqlite3";
import { definePlatformConformance, type PlatformHarness } from "@uniora/storage-conformance";
import { applyMigrations } from "./migrate.js";
import { AUDIT_APPEND_ONLY_TRIGGERS } from "./migrations/0003_audit_log_integrity.js";
import { AUDIT_CHECKPOINT_TRIGGERS } from "./migrations/0007_audit_log_retention.js";
import { MIGRATION_0022_PLATFORM } from "./migrations/0022_platform.js";
import { MIGRATION_0023_PLATFORM_HARDENING } from "./migrations/0023_platform_hardening.js";
import { createSqlitePlatformStorage } from "./platform-storage.js";
import { createSqliteStorage } from "./storage.js";

let db: Database.Database;

const TRIGGERS = [
  "uniora_platform_roles_system_update",
  "uniora_platform_roles_system_delete",
  "uniora_platform_members_last_admin_suspend",
  "uniora_platform_members_last_admin_delete",
  "uniora_platform_member_roles_last_admin",
  "uniora_platform_member_roles_last_admin_move",
  "uniora_platform_members_no_replace",
  "uniora_platform_roles_no_replace",
  "uniora_platform_members_id_immutable",
  "uniora_platform_roles_id_immutable",
  "uniora_platform_roles_system_flag_update",
  "uniora_platform_roles_system_flag_insert",
];

const attempt = (sql: string, ...params: unknown[]): "applied" | "rejected" => {
  try {
    db.prepare(sql).run(...params);
    return "applied";
  } catch {
    return "rejected";
  }
};

const harness: PlatformHarness = {
  name: "@uniora/sqlite",
  async setup() {
    db = new Database(":memory:");
    applyMigrations(db);
  },
  async teardown() {
    db?.close();
  },
  async reset() {
    // The guards would (rightly) refuse to empty the tables: take them off, empty, and put them back.
    for (const name of TRIGGERS) db.exec(`drop trigger if exists ${name}`);
    db.exec(`
      delete from uniora_platform_member_roles;
      delete from uniora_platform_members;
      delete from uniora_platform_roles;
      drop trigger if exists uniora_audit_logs_no_delete;
      drop trigger if exists uniora_audit_log_checkpoints_no_delete;
      delete from uniora_audit_log_checkpoints;
      delete from uniora_audit_logs;
      delete from uniora_support_grants;
      delete from uniora_membership_roles;
      delete from uniora_memberships;
      delete from uniora_roles;
      delete from uniora_permissions;
      delete from uniora_organizations;
    `);
    db.exec(MIGRATION_0022_PLATFORM);
    db.exec(MIGRATION_0023_PLATFORM_HARDENING);
    db.exec(AUDIT_APPEND_ONLY_TRIGGERS);
    db.exec(AUDIT_CHECKPOINT_TRIGGERS);
  },
  storage: () => createSqliteStorage(db),
  platform: () => createSqlitePlatformStorage(db),
  probe: {
    async suspendMemberDirectly(id) {
      return attempt("update uniora_platform_members set status = 'suspended' where id = ?", id);
    },
    async deleteMemberDirectly(id) {
      return attempt("delete from uniora_platform_members where id = ?", id);
    },
    async unassignAllRolesDirectly(id) {
      return attempt("delete from uniora_platform_member_roles where member_id = ?", id);
    },
    async updateRoleDirectly(id) {
      return attempt("update uniora_platform_roles set name = 'Hacked' where id = ?", id);
    },
    async deleteRoleDirectly(id) {
      return attempt("delete from uniora_platform_roles where id = ?", id);
    },
    async grantWildcardDirectly(id) {
      return attempt(`update uniora_platform_roles set permissions = '["platform.*"]' where id = ?`, id);
    },
    async moveRoleLinksDirectly(id, toRoleId) {
      return attempt("update uniora_platform_member_roles set role_id = ? where member_id = ?", toRoleId, id);
    },
    async overwriteMemberDirectly(id) {
      return attempt(
        `insert or replace into uniora_platform_members (id, identity_provider, identity_subject, status, created_at, updated_at, added_by_provider, added_by_subject)
         select id, identity_provider, identity_subject, 'suspended', created_at, updated_at, added_by_provider, added_by_subject from uniora_platform_members where id = ?`,
        id,
      );
    },
    async promoteToSystemRoleDirectly(id) {
      return attempt("update uniora_platform_roles set is_system = 1 where id = ?", id);
    },
    async insertSystemRoleDirectly(id) {
      return attempt(
        `insert into uniora_platform_roles (id, key, name, permissions, is_system, created_at, updated_at) values (?, 'evil', 'Evil', '["platform.*"]', 1, '2026-01-01', '2026-01-01')`,
        id,
      );
    },
  },
};

definePlatformConformance(harness);
