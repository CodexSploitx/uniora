import type { Database } from "better-sqlite3";
import type { PlatformStorage, PlatformTransaction } from "@uniora/core";
import { createExecutor } from "./executor.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createPlatformMemberRepository, createPlatformRoleRepository } from "./repositories/platform.js";

/**
 * SQLite implementation of `PlatformStorage` over a `better-sqlite3` connection you own: the platform tables of migration 0022
 * and the audit log for the entries it writes. Run `applyMigrations(db)` first. SQLite has no per-table privileges, so for real
 * separation open a second connection (or file) for it and keep it out of code that serves organizations.
 */
export function createSqlitePlatformStorage(db: Database): PlatformStorage {
  const executor = createExecutor(db);
  const scope: PlatformTransaction = {
    platformRoles: createPlatformRoleRepository(executor),
    platformMembers: createPlatformMemberRepository(executor),
    auditLogs: createAuditLogRepository(executor),
  };
  return {
    ...scope,
    transaction<T>(callback: (tx: PlatformTransaction) => Promise<T>): Promise<T> {
      return executor.atomic(() => callback(scope));
    },
  };
}
