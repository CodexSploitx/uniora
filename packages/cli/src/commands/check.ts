import type { CommonOptions } from "../cli/common.js";
import { emit, failReport, type CheckResult } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";
import { openDriver } from "../database/open.js";

/**
 * `npx uniora check` (docs/PROYECT.md §19): valida la configuración y prueba
 * la conexión a la base de datos. Nunca imprime `database.url` — solo el
 * proveedor y el destino (`host/base` sin usuario ni contraseña en Postgres,
 * la ruta del archivo en SQLite) — para no filtrar la connection string en la
 * salida del CLI ni en logs de CI. Es de solo lectura: con SQLite jamás crea
 * el archivo.
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

  try {
    const driver = await openDriver(config.database, cwd, "inspect");
    try {
      const probe = await driver.probe();
      checks.push({ name: "Conexión a la base de datos", severity: probe.severity, message: probe.message });
    } finally {
      await driver.close();
    }
  } catch (error) {
    checks.push({
      name: "Conexión a la base de datos",
      severity: "fail",
      message: `no se pudo conectar: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  emit({ command: "check", checks }, json);
}
