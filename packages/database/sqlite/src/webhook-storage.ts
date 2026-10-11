import type { Database } from "better-sqlite3";
import type { WebhookStorage, WebhookTransaction } from "@uniora/core";
import { createExecutor } from "./executor.js";
import { createAuditLogRepository } from "./repositories/audit-log.js";
import { createWebhookDeliveryRepository, createWebhookEndpointRepository } from "./repositories/webhooks.js";

/**
 * SQLite implementation of `WebhookStorage` over a `better-sqlite3` connection you own: the webhook endpoints and deliveries of
 * migration 0030 and the audit log for the entries it writes. Run `applyMigrations(db)` first. The endpoint rows hold the signing
 * secrets, and SQLite has no per-table privileges: open a second connection (or file) for it and keep it out of code that serves
 * organizations.
 */
export function createSqliteWebhookStorage(db: Database): WebhookStorage {
  const executor = createExecutor(db);
  const scope: WebhookTransaction = {
    endpoints: createWebhookEndpointRepository(executor),
    deliveries: createWebhookDeliveryRepository(executor),
    auditLogs: createAuditLogRepository(executor),
  };
  return {
    ...scope,
    transaction<T>(callback: (tx: WebhookTransaction) => Promise<T>): Promise<T> {
      return executor.atomic(() => callback(scope));
    },
  };
}
