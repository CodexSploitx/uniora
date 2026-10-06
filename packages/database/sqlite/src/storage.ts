import type { Database } from "better-sqlite3";
import type { UnioraStorage, UnioraTransaction } from "@uniora/core";
import { createExecutor, type SqliteExecutor } from "./executor.js";
import { createOrganizationRepository } from "./repositories/organization.js";
import { createMembershipRepository } from "./repositories/membership.js";
import { createRoleRepository } from "./repositories/role.js";
import { createPermissionRepository } from "./repositories/permission.js";
import { createFeatureRepository } from "./repositories/feature.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createIdentityLinkRepository } from "./repositories/identity-link.js";
import { createInvitationRepository } from "./repositories/invitation.js";

function createTransactionScope(db: SqliteExecutor): UnioraTransaction {
  // Built once and passed into `createIdentityLinkRepository` too: `link()`
  // self-audits through the exact same `AuditLogRepository` implementation
  // everything else uses, never a second, duplicated insert into
  // `uniora_audit_logs`.
  const auditLogs = createAuditLogRepository(db);
  return {
    organizations: createOrganizationRepository(db),
    memberships: createMembershipRepository(db),
    roles: createRoleRepository(db),
    permissions: createPermissionRepository(db),
    features: createFeatureRepository(db),
    auditLogs,
    identityLinks: createIdentityLinkRepository(db, auditLogs),
    invitations: createInvitationRepository(db),
  };
}

/**
 * SQLite implementation of `UnioraStorage`, over a `better-sqlite3`
 * connection you own. Run `applyMigrations(db)` once before using it on a
 * fresh database.
 *
 * Every operation on the connection is serialized, and each multi-statement
 * one runs in a `begin immediate` transaction — so a read-check-write
 * sequence (last-Owner guard, identity linking, ...) can't be interleaved by
 * another caller in this process or by another process on the same file.
 * Foreign-key enforcement is turned on (and verified) for the connection.
 */
export function createSqliteStorage(db: Database): UnioraStorage {
  const executor = createExecutor(db);
  const scope = createTransactionScope(executor);

  return {
    ...scope,
    // The callback gets the same repositories: the executor sees it already
    // owns the connection and joins the transaction instead of queueing
    // behind it. Calls the callback makes on the top-level `storage` instead
    // of `tx` join the same transaction rather than deadlocking.
    transaction<T>(callback: (tx: UnioraTransaction) => Promise<T>): Promise<T> {
      return executor.atomic(() => callback(scope));
    },
  };
}
