import { existsSync } from "node:fs";
import type { Database } from "better-sqlite3";
import {
  applyMigrations,
  getMigrationStatus,
  listMigrationIds,
  openSqliteDatabase,
  sqlitePathFromUrl,
} from "@uniora/sqlite";
import type { CheckResult } from "../cli/output.js";
import { ownerResult } from "./postgres.js";
import type { DatabaseDriver, DatabaseIntent, MigrationStatus } from "./types.js";

const PRISTINE_STATUS: () => MigrationStatus = () => ({
  ledgerPresent: false,
  applied: [],
  pending: listMigrationIds(),
  modified: [],
  unknown: [],
});

/**
 * `url` ya validada por `validateConfig`. Con intención `inspect` el archivo
 * **nunca se crea ni se modifica**: si no existe, el driver se comporta como una base virgen
 * (todo pendiente) en vez de dejar un `.db` vacío por haber mirado.
 */
export function createSqliteDriver(url: string, cwd: string, intent: DatabaseIntent): DatabaseDriver {
  const path = sqlitePathFromUrl(url, cwd);
  const absent = intent === "inspect" && !existsSync(path);
  // Mirar no es tocar: con `inspect` la conexión es de solo lectura, así que ni
  // siquiera puede cambiar el modo de journal (lo hace `migrate`, que escribe).
  // Escribir (`migrate`) sí activa WAL: es quien posee el archivo.
  const db: Database | undefined = absent
    ? undefined
    : openSqliteDatabase(path, intent === "inspect" ? { fileMustExist: true, readonly: true } : { wal: true });

  function requireDatabase(): Database {
    if (!db) throw new Error(`El archivo ${path} no existe todavía.`);
    return db;
  }

  return {
    provider: "sqlite",
    target: path,

    async probe() {
      if (!db) {
        return {
          severity: "warn",
          message: `el archivo ${path} no existe todavía; "uniora migrate" lo creará`,
        };
      }
      db.prepare("select 1").get();
      return { severity: "ok", message: `conectado a ${path}` };
    },

    async migrationStatus() {
      return db ? getMigrationStatus(db) : PRISTINE_STATUS();
    },

    async applyMigrations() {
      return applyMigrations(requireDatabase());
    },

    async engineChecks() {
      if (!db) return [];
      const checks: CheckResult[] = [];

      const { version } = db.prepare("select sqlite_version() as version").get() as { version: string };
      checks.push({ name: "SQLite", severity: "ok", message: `${version} (soportada)` });

      const journal = String(db.pragma("journal_mode", { simple: true }));
      checks.push(
        journal === "wal"
          ? { name: "Journal", severity: "ok", message: "WAL" }
          : {
              name: "Journal",
              severity: "warn",
              message: `${journal}: con varios procesos sobre el mismo archivo conviene WAL (lo activa "uniora migrate").`,
            },
      );

      const integrity = db.pragma("quick_check", { simple: true });
      checks.push(
        integrity === "ok"
          ? { name: "Integridad", severity: "ok", message: "quick_check ok" }
          : { name: "Integridad", severity: "fail", message: `quick_check reporta: ${String(integrity)}` },
      );
      return checks;
    },

    async ownerInvariant() {
      const rows = requireDatabase()
        .prepare(
          `select o.id, count(*) over () as total
             from uniora_organizations o
            where not exists (
              select 1 from uniora_roles r
                join uniora_membership_roles mr on mr.role_id = r.id
               where r.organization_id = o.id and r.is_owner_role = 1)
            order by o.id
            limit 5`,
        )
        .all() as { id: string; total: number }[];
      return ownerResult(rows.map((row) => row.id), Number(rows[0]?.total ?? 0));
    },

    async close() {
      db?.close();
    },
  };
}
