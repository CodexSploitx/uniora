import { Pool } from "pg";
import { applyMigrations, getMigrationStatus, type MigrationStatus } from "@uniora/postgres";
import type { CommonOptions } from "../cli/common.js";
import { describeDatabaseTarget, emit, failReport, type CheckResult, type Report } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";

export interface MigrateOptions extends CommonOptions {
  /** Solo reporta aplicadas/pendientes. Sale con código 1 si hay pendientes o modificadas (gate de CI). */
  readonly status?: boolean;
  /** Muestra qué aplicaría `migrate` sin tocar nada. Sale 0 salvo que `migrate` fuera a fallar. */
  readonly dryRun?: boolean;
}

function statusChecks(status: MigrationStatus, mode: "status" | "dry-run"): CheckResult[] {
  const checks: CheckResult[] = status.applied.map((migration) => ({
    name: migration.id,
    severity: status.modified.includes(migration.id) ? ("fail" as const) : ("ok" as const),
    message: status.modified.includes(migration.id)
      ? "aplicada, pero su SQL cambió desde entonces (checksum distinto)"
      : `aplicada (${migration.appliedAt.toISOString()})`,
  }));

  for (const id of status.pending) {
    checks.push({
      name: id,
      // En `--status` una pendiente es un fallo (el CI debe enterarse); en `--dry-run` es solo lo que se va a hacer.
      severity: mode === "status" ? "fail" : "warn",
      message: mode === "status" ? "pendiente" : "se aplicaría",
    });
  }
  for (const id of status.unknown) {
    checks.push({ name: id, severity: "warn", message: "registrada en la base pero desconocida para esta versión de UNIORA" });
  }
  return checks;
}

/**
 * `npx uniora migrate [--status | --dry-run]` (docs/PROYECT.md §19).
 *
 * Aplicar (sin flags) no pide confirmación: las migraciones de
 * @uniora/postgres son aditivas e idempotentes y se registran en
 * `uniora.schema_migrations` (ver `docs/postgres.md`) — cada una se aplica
 * una sola vez y una ya aplicada cuyo SQL cambió **bloquea** el comando. Si en
 * el futuro una migración pudiera ser destructiva, este comando debe pedir
 * confirmación explícita (skill §58). Siempre muestra `host/base` (nunca las
 * credenciales) para que el operador vea qué base va a tocar — importante con
 * `--env production`.
 */
export async function runMigrate(cwd: string = process.cwd(), options: MigrateOptions = {}): Promise<void> {
  const json = options.json === true;

  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    emit(failReport("migrate", "Configuración", error), json);
    return;
  }

  const target = describeDatabaseTarget(config.database.url);
  const pool = new Pool({ connectionString: config.database.url });
  let report: Report;

  try {
    if (options.status || options.dryRun) {
      const mode = options.status ? "status" : "dry-run";
      const status = await getMigrationStatus(pool);
      const checks = statusChecks(status, mode);
      if (status.modified.length > 0 && mode === "dry-run") {
        // `migrate` se negaría a correr — el dry-run debe reflejarlo, no prometer un éxito falso.
        checks.push({ name: "migrate", severity: "fail", message: "se negaría a aplicar: hay migraciones modificadas" });
      }
      report = {
        command: "migrate",
        checks,
        data: { mode, target, provider: config.database.provider, ...status },
      };
    } else {
      if (!json) console.log(`Aplicando migraciones de UNIORA (${config.database.provider}${target ? ` → ${target}` : ""})...`);
      const result = await applyMigrations(pool);
      const message =
        result.applied.length === 0
          ? "nada que aplicar: la base ya está al día"
          : `${result.applied.length} aplicada(s): ${result.applied.join(", ")}`;
      report = {
        command: "migrate",
        checks: [{ name: "Migraciones", severity: "ok", message }],
        data: { mode: "apply", target, provider: config.database.provider, ...result },
      };
    }
  } catch (error) {
    report = {
      command: "migrate",
      checks: [
        { name: "Migraciones", severity: "fail", message: error instanceof Error ? error.message : String(error) },
      ],
      data: { target },
    };
  } finally {
    await pool.end();
  }

  emit(report, json);
}
