import type { Pool } from "pg";
import type { WebhookStorage, WebhookTransaction } from "@uniora/core";
import type { Queryable } from "./queryable.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createWebhookDeliveryRepository, createWebhookEndpointRepository } from "./repositories/webhooks.js";

function scopeOf(db: Queryable, pool?: Pool): WebhookTransaction {
  return {
    endpoints: createWebhookEndpointRepository(db, pool),
    deliveries: createWebhookDeliveryRepository(db),
    auditLogs: createAuditLogRepository(db),
  };
}

/**
 * PostgreSQL implementation of `WebhookStorage`: the endpoints and deliveries of `uniora_webhooks` (migration 0045), and the audit
 * log of `uniora` for the entries it writes. The endpoint rows hold the signing secrets: build it over its OWN pool when you can (a
 * database user that reaches `uniora_webhooks`, which the user that serves organizations should not). Run `applyMigrations(pool)` first.
 */
export function createPostgresWebhookStorage(pool: Pool): WebhookStorage {
  const bound = scopeOf(pool, pool);
  return {
    ...bound,
    async transaction<T>(callback: (tx: WebhookTransaction) => Promise<T>): Promise<T> {
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
