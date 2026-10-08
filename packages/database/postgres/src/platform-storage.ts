import type { Pool } from "pg";
import type { PlatformStorage, PlatformTransaction } from "@uniora/core";
import type { Queryable } from "./queryable.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createPlatformMemberRepository, createPlatformRoleRepository } from "./repositories/platform.js";

function scopeOf(db: Queryable, pool?: Pool): PlatformTransaction {
  return {
    platformRoles: createPlatformRoleRepository(db, pool),
    platformMembers: createPlatformMemberRepository(db, pool),
    auditLogs: createAuditLogRepository(db),
    async lock(key: string): Promise<void> {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    },
  };
}

/**
 * PostgreSQL implementation of `PlatformStorage`: the platform roles and members of `uniora_platform` (migration 0037), and
 * the audit log of `uniora` for the entries it writes. Build it over its OWN pool when you can (a database user that
 * reaches `uniora_platform`, which the user that serves organizations should not), and keep it out of code that handles
 * organization requests. Run `applyMigrations(pool)` first.
 */
export function createPostgresPlatformStorage(pool: Pool): PlatformStorage {
  const bound = scopeOf(pool, pool);
  return {
    platformRoles: bound.platformRoles,
    platformMembers: bound.platformMembers,
    auditLogs: bound.auditLogs,
    async transaction<T>(callback: (tx: PlatformTransaction) => Promise<T>): Promise<T> {
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
