import { Pool } from "pg";
import type { CommonOptions } from "../cli/common.js";
import { describeDatabaseTarget, emit, failReport, type CheckResult } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";

/**
 * `npx uniora check` (docs/PROYECT.md §19): valida la configuración y prueba
 * la conexión a la base de datos. Nunca imprime `database.url` — solo el
 * proveedor y `host/base` (sin usuario ni contraseña) — para no filtrar la
 * connection string en la salida del CLI ni en logs de CI.
 */
export async function runCheck(cwd: string = process.cwd(), options: CommonOptions = {}): Promise<void> {
  const json = options.json === true;

  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    emit(failReport("check", "Configuración", error), json);
    return;
  }

  const checks: CheckResult[] = [
    { name: "Configuración", severity: "ok", message: `válida (proveedor de base de datos: ${config.database.provider})` },
  ];

  const pool = new Pool({ connectionString: config.database.url });
  try {
    await pool.query("select 1");
    const target = describeDatabaseTarget(config.database.url);
    checks.push({ name: "Conexión a la base de datos", severity: "ok", message: target ? `conectado a ${target}` : "conectado" });
  } catch (error) {
    checks.push({
      name: "Conexión a la base de datos",
      severity: "fail",
      message: `no se pudo conectar: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    await pool.end();
  }

  emit({ command: "check", checks }, json);
}
