import type { Pool } from "pg";
import type { ApiCredentialStorage, ApiCredentialTransaction } from "@uniora/core";
import type { Queryable } from "./queryable.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createApiClientRepository, createApiKeyRepository } from "./repositories/api-credentials.js";

function scopeOf(db: Queryable, pool?: Pool): ApiCredentialTransaction {
  return {
    apiClients: createApiClientRepository(db, pool),
    apiKeys: createApiKeyRepository(db, pool),
    auditLogs: createAuditLogRepository(db),
  };
}

/**
 * PostgreSQL implementation of `ApiCredentialStorage`: the API clients and keys of `uniora_api` (migration 0043), and the audit
 * log of `uniora` for the entries it writes. Build it over its OWN pool when you can (a database user that reaches
 * `uniora_api`, which the user that serves organizations should not). Run `applyMigrations(pool)` first.
 */
export function createPostgresApiCredentialStorage(pool: Pool): ApiCredentialStorage {
  const bound = scopeOf(pool, pool);
  return {
    ...bound,
    async transaction<T>(callback: (tx: ApiCredentialTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level read committed");
        const result = await callback(scopeOf(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
