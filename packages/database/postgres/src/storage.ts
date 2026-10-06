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
import { createInvitationRepository } from "./repositories/invitation.js";
import { createOutboxRepository } from "./repositories/outbox.js";
import { createEntitlementRepository } from "./repositories/entitlement.js";

function createTransactionScope(db: Queryable, pool?: Pool): UnioraTransaction {
  // Built once and passed into `createIdentityLinkRepository` too: `link()`
  // self-audits (docs/security-pentest-2026-09-24.md Hallazgo 5) through the
  // exact same `AuditLogRepository` implementation everything else uses,
  // never a second, duplicated insert into `uniora.audit_logs`.
  const auditLogs = createAuditLogRepository(db);
  return {
    organizations: createOrganizationRepository(db),
    // `pool` is only passed at the top level (never inside
    // `storage.transaction()`) — see the SECURITY FIX comment on
    // `create()` in `membership.ts` (docs/security-pentest-2026-09-24.md
    // Ronda 7).
    memberships: createMembershipRepository(db, pool),
    roles: createRoleRepository(db),
    permissions: createPermissionRepository(db),
    features: createFeatureRepository(db),
    auditLogs,
    // `pool` is only passed at the top level (never inside
    // `storage.transaction()`, where `db` is already the caller's own
    // transactional client) — see the SECURITY FIX comment on `link()` in
    // `identity-link.ts` (docs/security-pentest-2026-09-24.md Hallazgo 9).
    identityLinks: createIdentityLinkRepository(db, auditLogs, pool),
    invitations: createInvitationRepository(db),
    outbox: createOutboxRepository(db),
    entitlements: createEntitlementRepository(db),
    // Only meaningful inside `storage.transaction()` (xact-scoped lock); released on commit/rollback.
    async lock(key: string): Promise<void> {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    },
  };
}

/**
 * PostgreSQL implementation of `UnioraStorage` (docs/PROYECT.md §18).
 * Run `applyMigrations(pool)` once before using this in a fresh database.
 */
export function createPostgresStorage(pool: Pool): UnioraStorage {
  const bound = createTransactionScope(pool, pool);

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
