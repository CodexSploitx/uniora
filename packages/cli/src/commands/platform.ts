import { userInfo } from "node:os";
import { UsageError } from "../cli/args.js";
import type { CommonOptions } from "../cli/common.js";
import { emit, failReport, type CheckResult, type Report } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";
import { openDriver } from "../database/open.js";
import type { DatabaseDriver } from "../database/types.js";

export interface PlatformOptions extends CommonOptions {
  /** `proveedor:sujeto` del primer Platform Administrator (solo `init`). */
  readonly admin?: string;
}

/** `proveedor:sujeto` → identidad. El proveedor no puede contener `:`; el sujeto sí (se parte en el primero). */
export function parsePlatformIdentity(text: string): { provider: string; subject: string } {
  const index = text.indexOf(":");
  const provider = index === -1 ? "" : text.slice(0, index).trim();
  const subject = index === -1 ? "" : text.slice(index + 1).trim();
  if (provider === "" || subject === "") {
    throw new UsageError(`--admin "${text}" no es válido: usa proveedor:sujeto, p. ej. supabase:3f2c9a10-...`);
  }
  return { provider, subject };
}

function operator(): { provider: string; subject: string } {
  let name = "unknown";
  try {
    name = userInfo().username || name;
  } catch {
    // Sin usuario de sistema resoluble (contenedores raros): el auditado queda como "cli:unknown".
  }
  return { provider: "cli", subject: name };
}

/**
 * `uniora platform init --admin <proveedor:sujeto>` crea el rol de sistema Platform Administrator y a su primer miembro.
 * Funciona UNA vez: con la plataforma ya inicializada se niega. Exige acceso directo a la base de datos (la raíz de
 * confianza): no hay ninguna forma de hacerlo desde una petición HTTP. `uniora platform status` es de solo lectura.
 */
export async function runPlatform(sub: string | undefined, cwd: string = process.cwd(), options: PlatformOptions = {}): Promise<void> {
  const json = options.json === true;
  if (sub !== "init" && sub !== "status") throw new UsageError(`Uso: uniora platform <init|status>${sub ? ` ("${sub}" no existe)` : ""}.`);
  const command = `platform ${sub}`;

  let admin: { provider: string; subject: string } | undefined;
  if (sub === "init") {
    if (options.admin === undefined) throw new UsageError("platform init necesita --admin proveedor:sujeto.");
    admin = parsePlatformIdentity(options.admin);
  } else if (options.admin !== undefined) {
    throw new UsageError("--admin solo se usa con platform init.");
  }

  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    emit(failReport(command, "Configuración", error), json);
    return;
  }

  let driver: DatabaseDriver;
  try {
    driver = await openDriver(config.database, cwd, sub === "init" ? "write" : "inspect");
  } catch (error) {
    emit(failReport(command, "Plataforma", error), json);
    return;
  }

  let report: Report;
  try {
    const status = await driver.platformStatus();
    const checks: CheckResult[] = [];
    if (!status.migrated) {
      checks.push({ name: "Plataforma", severity: "fail", message: 'faltan las tablas de plataforma: corre "uniora migrate" primero' });
      report = { command, checks, data: { target: driver.target, ...status } };
    } else if (sub === "status") {
      checks.push(
        status.initialised
          ? { name: "Plataforma", severity: status.activeAdmins > 0 ? "ok" : "fail", message: `${status.members} miembro(s), ${status.activeAdmins} Platform Administrator activo(s)` }
          : { name: "Plataforma", severity: "ok", message: 'sin inicializar (opcional): "uniora platform init --admin proveedor:sujeto" crea el primer administrador' },
      );
      report = { command, checks, data: { target: driver.target, ...status } };
    } else if (status.initialised) {
      checks.push({ name: "Plataforma", severity: "fail", message: "ya está inicializada: añade administradores desde el servicio de plataforma, no desde el CLI" });
      report = { command, checks, data: { target: driver.target, ...status } };
    } else {
      const result = await driver.platformInit(admin!, operator());
      checks.push({
        name: "Plataforma",
        severity: "ok",
        message: `inicializada: ${admin!.provider}:${admin!.subject} es ahora Platform Administrator`,
      });
      report = { command, checks, data: { target: driver.target, ...result } };
    }
  } catch (error) {
    report = { command, checks: [{ name: "Plataforma", severity: "fail", message: error instanceof Error ? error.message : String(error) }], data: { target: driver.target } };
  } finally {
    await driver.close();
  }

  emit(report, json);
}
