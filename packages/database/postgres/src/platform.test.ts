import { afterAll, beforeAll, describe, it, expect } from "vitest";
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
    moveRoleLinksDirectly: (id, toRoleId) => attempt("update uniora_platform.member_roles set role_id = $2 where member_id = $1", [id, toRoleId]),
    overwriteMemberDirectly: (id) =>
      attempt(
        `insert into uniora_platform.members (id, identity_provider, identity_subject, status, added_by_provider, added_by_subject)
         select id, identity_provider, identity_subject, 'suspended', added_by_provider, added_by_subject from uniora_platform.members where id = $1
         on conflict (id) do update set status = 'suspended'`,
        [id],
      ),
    promoteToSystemRoleDirectly: (id) => attempt("update uniora_platform.roles set is_system = true where id = $1", [id]),
    insertSystemRoleDirectly: (id) =>
      attempt("insert into uniora_platform.roles (id, key, name, permissions, is_system) values ($1, 'evil', 'Evil', array['platform.*'], true)", [id]),
  },
};

definePlatformConformance(harness);

describe("@uniora/postgres — concurrent direct SQL on the last administrators", () => {
  beforeAll(async () => {
    pool = createTestPool();
    await applyMigrations(pool);
  });
  afterAll(() => pool.end());

  const seed = async (count: number) => {
    await harness.reset();
    const role = "11111111-1111-1111-1111-111111111111";
    await pool.query("insert into uniora_platform.roles (id, key, name, permissions, is_system) values ($1, 'platform_admin', 'Platform Administrator', array['platform.*'], true)", [role]);
    for (let i = 0; i < count; i++) {
      await pool.query("insert into uniora_platform.members (id, identity_provider, identity_subject, added_by_provider, added_by_subject) values ($1, 'a', $2, 'x', 'y')", [`m${i}`, `u${i}`]);
      await pool.query("insert into uniora_platform.member_roles values ($1, $2)", [`m${i}`, role]);
    }
  };
  const active = async () => Number((await pool.query("select count(*) n from uniora_platform.members where status = 'active'")).rows[0].n);

  for (const [level, count] of [["read committed", 2], ["read committed", 6], ["serializable", 2], ["repeatable read", 2], ["repeatable read", 4]] as const) {
    it(`never ends with zero administrators (${level}, ${count} administrators suspending each other)`, async () => {
      for (let round = 0; round < 5; round++) {
        await seed(count);
        const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
        try {
          await Promise.all(clients.map((client) => client.query(`begin isolation level ${level}`)));
          await Promise.all(clients.map((client) => client.query("select count(*) from uniora_platform.members")));
          await Promise.all(
            clients.map(async (client, i) => {
              try {
                await client.query("update uniora_platform.members set status = 'suspended' where id = $1", [`m${i}`]);
                await client.query("commit");
              } catch {
                await client.query("rollback").catch(() => undefined);
              }
            }),
          );
        } finally {
          clients.forEach((client) => client.release());
        }
        expect(await active()).toBeGreaterThanOrEqual(1);
      }
    });
  }
});
