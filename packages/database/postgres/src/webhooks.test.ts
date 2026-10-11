import type { Pool } from "pg";
import { defineWebhookConformance, type WebhookHarness } from "@uniora/storage-conformance";
import { createTestPool } from "./test-pool.js";
import { applyMigrations } from "./migrate.js";
import { createPostgresWebhookStorage } from "./webhook-storage.js";

let pool: Pool;

const harness: WebhookHarness = {
  name: "@uniora/postgres",
  async setup() {
    pool = createTestPool();
    await applyMigrations(pool);
  },
  async teardown() {
    await pool?.end();
  },
  async reset() {
    await pool.query("truncate table uniora_webhooks.deliveries, uniora_webhooks.endpoints cascade");
    await pool.query("truncate table uniora.audit_logs, uniora.audit_log_checkpoints cascade");
  },
  storage: () => createPostgresWebhookStorage(pool),
  probe: {
    async dumpWebhookText() {
      const rows = await pool.query("select secret as t from uniora_webhooks.endpoints");
      return rows.rows.map((row: { t: string }) => row.t).join("\n");
    },
  },
};

defineWebhookConformance(harness);
