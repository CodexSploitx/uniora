import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { getMigrationStatus } from "@uniora/postgres";
import type { CommonOptions } from "../cli/common.js";
import { describeDatabaseTarget, emit, type CheckResult } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";
import type { UnioraConfig } from "../config/types.js";
import { resolveStudio } from "./studio.js";

export type { CheckResult } from "../cli/output.js";

/** Versión mayor mínima de PostgreSQL con soporte upstream (14 sale de soporte en nov-2026). */
const MIN_SUPPORTED_POSTGRES_MAJOR = 14;

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

function postgresMajor(serverVersionNum: string): number {
  return Math.floor(Number(serverVersionNum) / 10000);
}

/**
 * Chequeos contra la base de datos. Nunca imprime `config.database.url`
 * (usuario/contraseña) — mismo criterio que `check` y `migrate`. Todo es de
 * **solo lectura**: si algo falta, indica qué comando correr, pero no lo
 * ejecuta (ninguna mutación implícita).
 */
export async function checkDatabase(config: UnioraConfig): Promise<CheckResult[]> {
  const pool = new Pool({ connectionString: config.database.url });
  const results: CheckResult[] = [];

  try {
    await pool.query("select 1");
    const target = describeDatabaseTarget(config.database.url);
    results.push({ name: "Conexión a la base de datos", severity: "ok", message: target ? `conectado a ${target}` : "conectado" });
  } catch (error) {
    await pool.end();
    return [
      { name: "Conexión a la base de datos", severity: "fail", message: error instanceof Error ? error.message : String(error) },
    ];
  }

  try {
    const version = await pool.query<{ server_version: string; server_version_num: string }>(
      "select current_setting('server_version') as server_version, current_setting('server_version_num') as server_version_num",
    );
    const row = version.rows[0];
    const major = row ? postgresMajor(row.server_version_num) : 0;
    results.push(
      major >= MIN_SUPPORTED_POSTGRES_MAJOR
        ? { name: "PostgreSQL", severity: "ok", message: `${row?.server_version} (soportada)` }
        : {
            name: "PostgreSQL",
            severity: "warn",
            message: `${row?.server_version ?? "versión desconocida"}: por debajo de la ${MIN_SUPPORTED_POSTGRES_MAJOR}, fuera de soporte upstream. Actualiza cuando puedas.`,
          },
    );

    const migrations = await getMigrationStatus(pool);
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
      results.push(await checkOwnerInvariant(pool));
    }
  } catch (error) {
    results.push({ name: "Diagnóstico de la base", severity: "fail", message: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }

  return results;
}

/**
 * Invariante "toda organización tiene ≥ 1 owner" (skill §11). Se garantiza al
 * crear con `createOrganizationWithOwner` y al no poder quitar el último
 * owner — pero una organización creada con `organizations.create()` a secas
 * (o insertada a mano en SQL) puede no tenerlo. Es `warn`, no `fail`: hay
 * usos legítimos (seeds, tests) y no es un fallo de la instalación, pero
 * quien administre debe saberlo.
 */
async function checkOwnerInvariant(pool: Pool): Promise<CheckResult> {
  const result = await pool.query<{ id: string; total: string }>(
    `select o.id, count(*) over () as total
       from uniora.organizations o
      where not exists (
        select 1 from uniora.roles r
          join uniora.membership_roles mr on mr.role_id = r.id
         where r.organization_id = o.id and r.is_owner_role)
      order by o.id
      limit 5`,
  );

  if (result.rows.length === 0) {
    return { name: "Owners", severity: "ok", message: "todas las organizaciones tienen al menos un owner" };
  }

  const total = Number(result.rows[0]?.total ?? 0);
  const sample = result.rows.map((row) => row.id).join(", ");
  return {
    name: "Owners",
    severity: "warn",
    message: `${total} organización(es) sin ningún miembro con el role Owner (${sample}${total > result.rows.length ? ", …" : ""}). Créalas con createOrganizationWithOwner() o asigna el Owner role a un miembro.`,
  };
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
 * configuración, conexión, versión de PostgreSQL, estado de las migraciones,
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
    checks.push(...(await checkDatabase(config)));
  }
  checks.push(checkStudio());

  emit({ command: "doctor", checks }, options.json === true);
}
