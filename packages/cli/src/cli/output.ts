export type Severity = "ok" | "warn" | "fail";

export interface CheckResult {
  readonly name: string;
  readonly severity: Severity;
  readonly message: string;
}

export interface Report {
  readonly command: string;
  readonly checks: readonly CheckResult[];
  /** Datos estructurados extra (solo aparecen en `--json`). Nunca deben incluir la connection string. */
  readonly data?: Readonly<Record<string, unknown>>;
}

const SEVERITY_MARKER: Record<Severity, string> = { ok: "✓", warn: "•", fail: "✗" };

export function isOk(report: Report): boolean {
  return !report.checks.some((check) => check.severity === "fail");
}

/**
 * Único punto de salida de los comandos de diagnóstico/migración.
 *
 * - Modo humano: una línea por check.
 * - `--json`: **un solo** objeto JSON en stdout (`{ ok, command, checks, ...data }`), sin ninguna
 *   otra salida, para que un CI lo consuma con `jq`.
 *
 * Fija `process.exitCode = 1` si algún check es `fail` (0 si no).
 */
export function emit(report: Report, json: boolean): void {
  const ok = isOk(report);

  if (json) {
    console.log(JSON.stringify({ ok, command: report.command, checks: report.checks, ...report.data }, null, 2));
  } else {
    for (const check of report.checks) {
      console.log(`${SEVERITY_MARKER[check.severity]} ${check.name}: ${check.message}`);
    }
  }

  if (!ok) process.exitCode = 1;
}

/** Un `fail` único (p. ej. config inválida antes de poder correr nada más). */
export function failReport(command: string, name: string, error: unknown): Report {
  return { command, checks: [{ name, severity: "fail", message: error instanceof Error ? error.message : String(error) }] };
}

/**
 * `host:port/base` de una connection string, **sin usuario, contraseña ni query**.
 * Sirve para que el operador vea *qué* base va a tocar un comando (skill §58: objetivo
 * claro antes de mutar) sin filtrar credenciales. Devuelve `undefined` si no parsea.
 */
export function describeDatabaseTarget(connectionString: string): string | undefined {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, "");
    return `${url.host}${database ? `/${database}` : ""}`;
  } catch {
    return undefined;
  }
}
