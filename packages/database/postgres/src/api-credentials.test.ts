import type { Pool } from "pg";
import { defineApiCredentialConformance, type ApiHarness } from "@uniora/storage-conformance";
import { createTestPool } from "./test-pool.js";
import { applyMigrations } from "./migrate.js";
import { createPostgresApiCredentialStorage } from "./api-credential-storage.js";

let pool: Pool;

const harness: ApiHarness = {
  name: "@uniora/postgres",
  async setup() {
    pool = createTestPool();
    await applyMigrations(pool);
  },
  async teardown() {
    await pool?.end();
  },
  async reset() {
    await pool.query("truncate table uniora_api.keys, uniora_api.clients cascade");
    await pool.query("truncate table uniora.audit_logs, uniora.audit_log_checkpoints cascade");
  },
  storage: () => createPostgresApiCredentialStorage(pool),
  probe: {
    async dumpCredentialText() {
      const clients = await pool.query("select row_to_json(c)::text as t from uniora_api.clients c");
      const keys = await pool.query("select row_to_json(k)::text as t from uniora_api.keys k");
      return [...clients.rows, ...keys.rows].map((row: { t: string }) => row.t).join("\n");
    },
  },
};

defineApiCredentialConformance(harness);
