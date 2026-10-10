import type { ApiCredentialStorage, UnioraStorage } from "@uniora/core";
import type { CheckResult } from "../cli/output.js";
import type { UnioraDatabaseConfig } from "../config/types.js";

export type DatabaseProvider = UnioraDatabaseConfig["provider"];

/** Forma común del ledger de migraciones de cada adapter (`@uniora/postgres`, `@uniora/sqlite`). */
export interface MigrationStatus {
  readonly ledgerPresent: boolean;
  readonly applied: readonly { readonly id: string; readonly appliedAt: Date }[];
  readonly pending: readonly string[];
  readonly modified: readonly string[];
  readonly unknown: readonly string[];
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** Resultado de probar la conexión. `warn` = "no es un error, pero conviene saberlo" (p. ej. el archivo SQLite aún no existe). */
export interface ConnectionProbe {
  readonly severity: "ok" | "warn";
  readonly message: string;
}

/** Estado del ámbito de plataforma (`uniora platform status`). */
export interface PlatformStatus {
  /** ¿Existen ya las tablas de plataforma (migración aplicada)? */
  readonly migrated: boolean;
  /** ¿Hay al menos un miembro de plataforma? */
  readonly initialised: boolean;
  readonly members: number;
  readonly activeAdmins: number;
}

export interface PlatformInitResult {
  readonly memberId: string;
  readonly roleId: string;
}

/**
 * Lo que los comandos (`check`, `migrate`, `doctor`) necesitan de una base de
 * datos, sin saber cuál es. Cada proveedor la implementa en su propio
 * dialecto; los comandos nunca tocan `pg` ni `better-sqlite3`.
 *
 * Nada de lo que expone incluye credenciales: `target` y los mensajes son
 * seguros de imprimir y de volcar a logs de CI.
 */
export interface DatabaseDriver {
  readonly provider: DatabaseProvider;
  /** Qué base se va a tocar, apto para mostrar: `host:puerto/base` en Postgres, la ruta del archivo en SQLite. */
  readonly target: string | undefined;

  /** Prueba la conexión. Lanza si no se puede conectar. */
  probe(): Promise<ConnectionProbe>;
  /** Solo lectura: nunca crea nada. Una base virgen reporta todo pendiente. */
  migrationStatus(): Promise<MigrationStatus>;
  /** Aplica las migraciones pendientes. Solo disponible con intención `"write"`. */
  applyMigrations(): Promise<MigrationRunResult>;
  /** Chequeos propios del motor para `doctor` (versión, integridad...). Vacío si no hay conexión útil. */
  engineChecks(): Promise<CheckResult[]>;
  /** Recalcula la cadena de hashes del audit log (auditoría F-04). Solo con el esquema completo. */
  auditIntegrity(): Promise<CheckResult>;
  /** Invariante "toda organización tiene ≥ 1 owner". Solo tiene sentido con el esquema completo. */
  ownerInvariant(): Promise<CheckResult>;
  /** Solo lectura. */
  platformStatus(): Promise<PlatformStatus>;
  /** Crea el rol de sistema y el primer Platform Administrator. Falla si la plataforma ya está inicializada. Solo con intención `"write"`. */
  platformInit(admin: { provider: string; subject: string }, actor: { provider: string; subject: string }): Promise<PlatformInitResult>;
  /** Credenciales de la API (clientes y claves). Lanza si la base aún no existe. Las tablas deben estar migradas. */
  apiCredentials(): ApiCredentialStorage;
  /** El storage de organizaciones, para `uniora server start`. */
  storage(): UnioraStorage;
  close(): Promise<void>;
}

/**
 * `inspect`: comandos de solo lectura (`check`, `doctor`, `migrate --status/--dry-run`) —
 * jamás deben crear la base. `write`: `migrate`, que sí puede crearla.
 */
export type DatabaseIntent = "inspect" | "write";
