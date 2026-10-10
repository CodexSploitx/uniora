import type { Database } from "better-sqlite3";
import type { ApiCredentialStorage, ApiCredentialTransaction } from "@uniora/core";
import { createExecutor } from "./executor.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createApiClientRepository, createApiKeyRepository } from "./repositories/api-credentials.js";

/**
 * SQLite implementation of `ApiCredentialStorage` over a `better-sqlite3` connection you own: the API clients and keys of
 * migration 0028 and the audit log for the entries it writes. Run `applyMigrations(db)` first. SQLite has no per-table
 * privileges, so for real separation open a second connection (or file) for it and keep it out of code that serves
 * organizations.
 */
export function createSqliteApiCredentialStorage(db: Database): ApiCredentialStorage {
  const executor = createExecutor(db);
  const scope: ApiCredentialTransaction = {
    apiClients: createApiClientRepository(executor),
    apiKeys: createApiKeyRepository(executor),
    auditLogs: createAuditLogRepository(executor),
  };
  return {
    ...scope,
    transaction<T>(callback: (tx: ApiCredentialTransaction) => Promise<T>): Promise<T> {
      return executor.atomic(() => callback(scope));
    },
  };
}
