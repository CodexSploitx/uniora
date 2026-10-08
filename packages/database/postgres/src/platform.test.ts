import type { Pool } from "pg";
import { definePlatformConformance, type PlatformHarness } from "@uniora/storage-conformance";
import { createTestPool } from "./test-pool.js";
import { applyMigrations } from "./migrate.js";
import { createPostgresStorage } from "./storage.js";
import { createPostgresPlatformStorage } from "./platform-storage.js";

let pool: Pool;

const attempt = (sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then(
    () => "applied" as const,
    () => "rejected" as const,
  );

const harness: PlatformHarness = {
  name: "@uniora/postgres",
  async setup() {
    pool = createTestPool();
    await applyMigrations(pool);
  },
  async teardown() {
    await pool?.end();
  },
  async reset() {
    await pool.query(`truncate table uniora_platform.member_roles, uniora_platform.members, uniora_platform.roles`);
    await pool.query(
      `truncate table uniora.invitation_roles, uniora.invitations, uniora.membership_roles, uniora.role_permissions, uniora.memberships,
              uniora.roles, uniora.features, uniora.feature_definitions, uniora.permissions,
              uniora.audit_logs, uniora.audit_log_checkpoints, uniora.identity_links, uniora.outbox, uniora.entitlement_definitions, uniora.support_grants, uniora.organizations cascade`,
    );
  },
  storage: () => createPostgresStorage(pool),
  platform: () => createPostgresPlatformStorage(pool),
  probe: {
    suspendMemberDirectly: (id) => attempt("update uniora_platform.members set status = 'suspended' where id = $1", [id]),
    deleteMemberDirectly: (id) => attempt("delete from uniora_platform.members where id = $1", [id]),
    unassignAllRolesDirectly: (id) => attempt("delete from uniora_platform.member_roles where member_id = $1", [id]),
    updateRoleDirectly: (id) => attempt("update uniora_platform.roles set name = 'Hacked' where id = $1", [id]),
    deleteRoleDirectly: (id) => attempt("delete from uniora_platform.roles where id = $1", [id]),
    grantWildcardDirectly: (id) => attempt("update uniora_platform.roles set permissions = array['platform.*'] where id = $1", [id]),
  },
};

definePlatformConformance(harness);
