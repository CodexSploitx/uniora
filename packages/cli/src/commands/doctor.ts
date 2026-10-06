import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommonOptions } from "../cli/common.js";
import { emit, type CheckResult } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";
import type { UnioraConfig } from "../config/types.js";
import { openDriver } from "../database/open.js";
import { resolveStudio } from "./studio.js";

export type { CheckResult } from "../cli/output.js";

/**
 * Feature-detección en vez de parsear `process.version` con semver: lo único
 * que nos importa es si la API de la que dependemos (`.env` sin dependencia
 * extra) existe, no un número de versión exacto que podría cambiar entre
 * builds de Node (skill §36 — preferir chequeos deterministas simples).
 */
export function checkNodeRuntime(): CheckResult {
  if (typeof process.loadEnvFile !== "function") {
    return {
      name: "Node.js",
      severity: "fail",
      message: `${process.version} no expone process.loadEnvFile. UNIORA requiere Node.js >= 20.6.`,
    };
  }
  return { name: "Node.js", severity: "ok", message: `${process.version} (compatible)` };
}

/**
 * ¿Ignora git el archivo de entorno? Con `envName` comprueba `.env.<envName>`
 * (que `--env` carga): un `.env.production` sin ignorar es el mismo riesgo de
 * commitear secretos que un `.env`.
 */
export function checkGitignore(cwd: string, envName?: string): CheckResult {
  const path = join(cwd, ".gitignore");
  const envFile = envName ? `.env.${envName}` : ".env";

  if (!existsSync(path)) {
    return {
      name: ".gitignore",
      severity: "warn",
      message: `No existe .gitignore — riesgo de commitear ${envFile}. Corre "uniora init".`,
    };
  }

  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim());

  // `.env.*` cubre cualquier entorno, pero también `.env.example` — solo lo aceptamos para archivos con nombre.
  const covered = envName ? lines.includes(envFile) || lines.includes(".env.*") : lines.includes(".env");
  if (!covered) {
    return {
      name: ".gitignore",
      severity: "warn",
      message: `${envFile} no está en .gitignore — riesgo de commitear secretos.${envName ? ` Añade "${envFile}".` : ' Corre "uniora init".'}`,
    };
  }

  return { name: ".gitignore", severity: "ok", message: `${envFile} está ignorado` };
}

/**
 * Chequeos contra la base de datos. Nunca imprime `config.database.url`
 * (usuario/contraseña) — mismo criterio que `check` y `migrate`. Todo es de
 * **solo lectura**: si algo falta, indica qué comando correr, pero no lo
 * ejecuta (ninguna mutación implícita; con SQLite ni siquiera crea el archivo).
 */
export async function checkDatabase(config: UnioraConfig, cwd: string = process.cwd()): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  let driver;
  try {
    driver = await openDriver(config.database, cwd, "inspect");
    const probe = await driver.probe();
    results.push({ name: "Conexión a la base de datos", severity: probe.severity, message: probe.message });
  } catch (error) {
    await driver?.close();
    return [
      { name: "Conexión a la base de datos", severity: "fail", message: error instanceof Error ? error.message : String(error) },
    ];
  }

  try {
    results.push(...(await driver.engineChecks()));

    const migrations = await driver.migrationStatus();
    if (migrations.modified.length > 0) {
      results.push({
        name: "Migraciones",
        severity: "fail",
        message: `${migrations.modified.join(", ")} ya se aplicaron pero su SQL cambió (checksum distinto). "uniora migrate" se negará a continuar.`,
      });
    } else if (migrations.pending.length > 0) {
      results.push({
        name: "Migraciones",
        severity: "warn",
        message: `${migrations.pending.length} pendiente(s) (${migrations.pending.join(", ")}). Corre "uniora migrate".`,
      });
    } else {
      results.push({ name: "Migraciones", severity: "ok", message: `${migrations.applied.length} aplicadas, ninguna pendiente` });
    }
    if (migrations.unknown.length > 0) {
      results.push({
        name: "Migraciones desconocidas",
        severity: "warn",
        message: `${migrations.unknown.join(", ")} están en la base pero esta versión de UNIORA no las conoce (¿base más nueva que el código?).`,
      });
    }

    // Las consultas de integridad asumen el schema completo: solo si no falta ninguna migración.
    if (migrations.ledgerPresent && migrations.pending.length === 0 && migrations.modified.length === 0) {
      results.push(await driver.ownerInvariant());
      results.push(await driver.auditIntegrity());
    }
  } catch (error) {
    results.push({ name: "Diagnóstico de la base", severity: "fail", message: error instanceof Error ? error.message : String(error) });
  } finally {
    await driver.close();
  }

  return results;
}

export function checkStudio(): CheckResult {
  try {
    resolveStudio();
    return { name: "Studio", severity: "ok", message: "disponible (compilado)" };
  } catch (error) {
    return { name: "Studio", severity: "warn", message: `${error instanceof Error ? error.message : String(error)} (solo afecta a "uniora studio")` };
  }
}

/**
 * `npx uniora doctor` (docs/PROYECT.md §19): diagnóstico de solo lectura,
 * más profundo que `check`: runtime de Node, higiene de `.gitignore`,
 * configuración, conexión, versión del motor (PostgreSQL o SQLite), estado de las migraciones,
 * invariante de owners y disponibilidad de Studio. Nunca modifica nada.
 */
export async function runDoctor(cwd: string = process.cwd(), options: CommonOptions = {}): Promise<void> {
  const checks: CheckResult[] = [checkNodeRuntime(), checkGitignore(cwd, options.envName)];

  let config: UnioraConfig | undefined;
  try {
    config = await loadConfig(cwd, options);
    checks.push({
      name: "Configuración",
      severity: "ok",
      message: `válida (proveedor: ${config.database.provider}${options.envName ? `, entorno: ${options.envName}` : ""})`,
    });
  } catch (error) {
    checks.push({ name: "Configuración", severity: "fail", message: error instanceof Error ? error.message : String(error) });
  }

  if (config) {
    checks.push(...(await checkDatabase(config, cwd)));
  }
  checks.push(checkStudio());

  emit({ command: "doctor", checks }, options.json === true);
}
