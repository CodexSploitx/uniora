import type { Pool } from "pg";
import type { UnioraStorage, UnioraTransaction } from "@uniora/core";
import type { Queryable } from "./queryable.js";
import { createOrganizationRepository } from "./repositories/organization.js";
import { createMembershipRepository } from "./repositories/membership.js";
import { createRoleRepository } from "./repositories/role.js";
import { createPermissionRepository } from "./repositories/permission.js";
import { createFeatureRepository } from "./repositories/feature.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createIdentityLinkRepository } from "./repositories/identity-link.js";

function createTransactionScope(db: Queryable): UnioraTransaction {
  return {
    organizations: createOrganizationRepository(db),
    memberships: createMembershipRepository(db),
    roles: createRoleRepository(db),
    permissions: createPermissionRepository(db),
    features: createFeatureRepository(db),
    auditLogs: createAuditLogRepository(db),
    identityLinks: createIdentityLinkRepository(db),
  };
}

/**
 * PostgreSQL implementation of `UnioraStorage` (docs/PROYECT.md §18).
 * Run `applyMigrations(pool)` once before using this in a fresh database.
 */
export function createPostgresStorage(pool: Pool): UnioraStorage {
  const bound = createTransactionScope(pool);

  return {
    ...bound,
    async transaction<T>(callback: (tx: UnioraTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await callback(createTransactionScope(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
