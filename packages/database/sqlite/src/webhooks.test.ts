import Database from "better-sqlite3";
import { defineWebhookConformance, type WebhookHarness } from "@uniora/storage-conformance";
import { applyMigrations } from "./migrate.js";
import { createSqliteWebhookStorage } from "./webhook-storage.js";

let db: Database.Database;

const harness: WebhookHarness = {
  name: "@uniora/sqlite",
  async setup() {
    db = new Database(":memory:");
    applyMigrations(db);
  },
  async teardown() {
    db?.close();
  },
  async reset() {
    db.exec(`
      delete from uniora_webhook_deliveries;
      delete from uniora_webhook_endpoints;
      drop trigger if exists uniora_audit_logs_no_delete;
      drop trigger if exists uniora_audit_log_checkpoints_no_delete;
      delete from uniora_audit_log_checkpoints;
      delete from uniora_audit_logs;
    `);
  },
  storage: () => createSqliteWebhookStorage(db),
  probe: {
    async dumpWebhookText() {
      const rows = db.prepare("select secret as t from uniora_webhook_endpoints").all();
      return rows.map((row) => (row as { t: string }).t).join("\n");
    },
  },
};

defineWebhookConformance(harness);
