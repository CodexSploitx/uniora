import Database from "better-sqlite3";
import { defineApiCredentialConformance, type ApiHarness } from "@uniora/storage-conformance";
import { applyMigrations } from "./migrate.js";
import { createSqliteApiCredentialStorage } from "./api-credential-storage.js";

let db: Database.Database;

const harness: ApiHarness = {
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
      delete from uniora_api_keys;
      delete from uniora_api_clients;
      drop trigger if exists uniora_audit_logs_no_delete;
      drop trigger if exists uniora_audit_log_checkpoints_no_delete;
      delete from uniora_audit_log_checkpoints;
      delete from uniora_audit_logs;
    `);
  },
  storage: () => createSqliteApiCredentialStorage(db),
  probe: {
    async dumpCredentialText() {
      const clients = db.prepare("select json_object('id', id, 'name', name, 'scopes', scopes, 'organization_ids', organization_ids) as t from uniora_api_clients").all();
      const keys = db.prepare("select json_object('id', id, 'client_id', client_id, 'secret_hash', secret_hash, 'hint', hint) as t from uniora_api_keys").all();
      return [...clients, ...keys].map((row) => (row as { t: string }).t).join("\n");
    },
  },
};

defineApiCredentialConformance(harness);
