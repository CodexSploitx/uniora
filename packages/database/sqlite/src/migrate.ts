import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { MIGRATION_0001_INIT } from "./migrations/0001_init.js";
import { MIGRATION_0002_INVITATIONS } from "./migrations/0002_invitations.js";
import { MIGRATION_0003_AUDIT_LOG_INTEGRITY } from "./migrations/0003_audit_log_integrity.js";
import { MIGRATION_0004_FEATURE_DEFAULTS_HIERARCHY } from "./migrations/0004_feature_defaults_hierarchy.js";
import { MIGRATION_0005_MEMBERSHIP_STATUS } from "./migrations/0005_membership_status.js";
import { MIGRATION_0006_AUDIT_LOG_SEARCH_INDEXES } from "./migrations/0006_audit_log_search_indexes.js";
import { MIGRATION_0007_AUDIT_LOG_RETENTION } from "./migrations/0007_audit_log_retention.js";
import { MIGRATION_0008_ORGANIZATION_STATUS } from "./migrations/0008_organization_status.js";
import { MIGRATION_0009_ROLE_SYSTEM_DESCRIPTION } from "./migrations/0009_role_system_description.js";
import { MIGRATION_0010_PERMISSION_GROUPS_IMPLICATIONS } from "./migrations/0010_permission_groups_implications.js";
import { MIGRATION_0011_OUTBOX } from "./migrations/0011_outbox.js";
import { MIGRATION_0012_ENTITLEMENTS } from "./migrations/0012_entitlements.js";
import { MIGRATION_0013_SUPPORT_GRANTS } from "./migrations/0013_support_grants.js";
import { MIGRATION_0014_MEMBERSHIP_SUSPENSION } from "./migrations/0014_membership_suspension.js";
import { MIGRATION_0015_ROW_VERSIONS } from "./migrations/0015_row_versions.js";
import { MIGRATION_0016_ROLE_NAME_NORMALIZED } from "./migrations/0016_role_name_normalized.js";
import { MIGRATION_0017_INVITATION_IDEMPOTENCY } from "./migrations/0017_invitation_idempotency.js";
import { MIGRATION_0018_MEMBERSHIP_FEATURE_VERSIONS } from "./migrations/0018_membership_feature_versions.js";
import { MIGRATION_0019_TEAMS } from "./migrations/0019_teams.js";
import { MIGRATION_0020_INVITATION_TEAMS } from "./migrations/0020_invitation_teams.js";
import { MIGRATION_0021_TEAM_HIERARCHY } from "./migrations/0021_team_hierarchy.js";
import { MIGRATION_0022_PLATFORM } from "./migrations/0022_platform.js";
import { MIGRATION_0023_PLATFORM_HARDENING } from "./migrations/0023_platform_hardening.js";
import { MIGRATION_0024_SEARCH_INDEXES } from "./migrations/0024_search_indexes.js";
import { MIGRATION_0025_POLICIES } from "./migrations/0025_policies.js";

interface Migration {
  readonly id: string;
  readonly sql: string;
}

/** Orden = orden de aplicación. Un `id` nunca se reutiliza ni se renombra: es la clave del ledger. */
const MIGRATIONS: readonly Migration[] = [
  { id: "0001_init", sql: MIGRATION_0001_INIT },
  { id: "0002_invitations", sql: MIGRATION_0002_INVITATIONS },
  { id: "0003_audit_log_integrity", sql: MIGRATION_0003_AUDIT_LOG_INTEGRITY },
  { id: "0004_feature_defaults_hierarchy", sql: MIGRATION_0004_FEATURE_DEFAULTS_HIERARCHY },
  { id: "0005_membership_status", sql: MIGRATION_0005_MEMBERSHIP_STATUS },
  { id: "0006_audit_log_search_indexes", sql: MIGRATION_0006_AUDIT_LOG_SEARCH_INDEXES },
  { id: "0007_audit_log_retention", sql: MIGRATION_0007_AUDIT_LOG_RETENTION },
  { id: "0008_organization_status", sql: MIGRATION_0008_ORGANIZATION_STATUS },
  { id: "0009_role_system_description", sql: MIGRATION_0009_ROLE_SYSTEM_DESCRIPTION },
  { id: "0010_permission_groups_implications", sql: MIGRATION_0010_PERMISSION_GROUPS_IMPLICATIONS },
  { id: "0011_outbox", sql: MIGRATION_0011_OUTBOX },
  { id: "0012_entitlements", sql: MIGRATION_0012_ENTITLEMENTS },
  { id: "0013_support_grants", sql: MIGRATION_0013_SUPPORT_GRANTS },
  { id: "0014_membership_suspension", sql: MIGRATION_0014_MEMBERSHIP_SUSPENSION },
  { id: "0015_row_versions", sql: MIGRATION_0015_ROW_VERSIONS },
  { id: "0016_role_name_normalized", sql: MIGRATION_0016_ROLE_NAME_NORMALIZED },
  { id: "0017_invitation_idempotency", sql: MIGRATION_0017_INVITATION_IDEMPOTENCY },
  { id: "0018_membership_feature_versions", sql: MIGRATION_0018_MEMBERSHIP_FEATURE_VERSIONS },
  { id: "0019_teams", sql: MIGRATION_0019_TEAMS },
  { id: "0020_invitation_teams", sql: MIGRATION_0020_INVITATION_TEAMS },
  { id: "0021_team_hierarchy", sql: MIGRATION_0021_TEAM_HIERARCHY },
  { id: "0022_platform", sql: MIGRATION_0022_PLATFORM },
  { id: "0023_platform_hardening", sql: MIGRATION_0023_PLATFORM_HARDENING },
  { id: "0024_search_indexes", sql: MIGRATION_0024_SEARCH_INDEXES },
  { id: "0025_policies", sql: MIGRATION_0025_POLICIES },
];

const LEDGER_TABLE = "uniora_schema_migrations";

const ENSURE_LEDGER = `
create table if not exists ${LEDGER_TABLE} (
  id text primary key,
  checksum text not null,
  applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

/** Error de migración (checksum modificado, etc.). Siempre falla cerrado: no se aplica nada. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export interface AppliedMigration {
  readonly id: string;
  readonly appliedAt: Date;
}

export interface MigrationStatus {
  /** ¿Existe ya la tabla `uniora_schema_migrations`? `false` en una base nueva. */
  readonly ledgerPresent: boolean;
  /** Migraciones registradas en el ledger, en orden de aplicación. */
  readonly applied: readonly AppliedMigration[];
  /** Migraciones de esta versión que aún no están en el ledger, en orden. */
  readonly pending: readonly string[];
  /** Registradas, pero cuyo SQL cambió desde que se aplicaron (checksum distinto). Bloquea `applyMigrations`. */
  readonly modified: readonly string[];
  /** Registradas en la base pero desconocidas para esta versión (la base es más nueva que el código). */
  readonly unknown: readonly string[];
}

/** Todas las migraciones de esta versión (id y SQL exacto), en orden: lo que `applyMigrations` ejecuta. */
export function listMigrations(): ReadonlyArray<{ readonly id: string; readonly sql: string }> {
  return MIGRATIONS.map((migration) => ({ id: migration.id, sql: migration.sql }));
}

/** Ids de todas las migraciones que esta versión conoce, en orden. */
export function listMigrationIds(): string[] {
  return MIGRATIONS.map((migration) => migration.id);
}

interface LedgerRow {
  id: string;
  checksum: string;
  applied_at: string;
}

function ledgerExists(db: Database): boolean {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(LEDGER_TABLE) !== undefined;
}

/**
 * Estado del ledger. **Solo lectura**: nunca crea la tabla, así que es seguro
 * contra una base que UNIORA aún no ha tocado (`migrate --status`, `doctor`).
 */
export function getMigrationStatus(db: Database): MigrationStatus {
  if (!ledgerExists(db)) {
    return { ledgerPresent: false, applied: [], pending: listMigrationIds(), modified: [], unknown: [] };
  }

  const rows = db.prepare(`select id, checksum, applied_at from ${LEDGER_TABLE} order by applied_at, id`).all() as LedgerRow[];

  const known = new Map(MIGRATIONS.map((migration) => [migration.id, checksum(migration.sql)]));
  const recorded = new Set(rows.map((row) => row.id));

  return {
    ledgerPresent: true,
    applied: rows.map((row) => ({ id: row.id, appliedAt: new Date(row.applied_at) })),
    pending: MIGRATIONS.filter((migration) => !recorded.has(migration.id)).map((migration) => migration.id),
    modified: rows.filter((row) => known.has(row.id) && known.get(row.id) !== row.checksum).map((row) => row.id),
    unknown: rows.filter((row) => !known.has(row.id)).map((row) => row.id),
  };
}

export interface MigrationRunResult {
  /** Migraciones aplicadas en esta llamada. */
  readonly applied: readonly string[];
  /** Migraciones que ya estaban registradas y se omitieron. */
  readonly skipped: readonly string[];
}

/**
 * Aplica las migraciones pendientes, en orden, y las registra en
 * `uniora_schema_migrations`. Segura de correr repetidamente: lo ya
 * registrado no se re-ejecuta.
 *
 * - Todo corre dentro de UNA transacción `begin immediate`: SQLite solo admite
 *   un escritor, así que eso serializa a dos procesos que migren a la vez (el
 *   equivalente del advisory lock de Postgres) y, como el DDL de SQLite es
 *   transaccional, o queda aplicado **y** registrado todo, o nada.
 * - Si el SQL de una migración ya registrada cambió (checksum distinto)
 *   lanza `MigrationError` **antes** de aplicar nada.
 */
export function applyMigrations(db: Database): MigrationRunResult {
  db.exec("begin immediate");
  try {
    db.exec(ENSURE_LEDGER);

    const recorded = db.prepare(`select id, checksum from ${LEDGER_TABLE}`).all() as Pick<LedgerRow, "id" | "checksum">[];
    const byId = new Map(recorded.map((row) => [row.id, row.checksum]));

    const modified = MIGRATIONS.filter(
      (migration) => byId.has(migration.id) && byId.get(migration.id) !== checksum(migration.sql),
    ).map((migration) => migration.id);
    if (modified.length > 0) {
      throw new MigrationError(
        `Las migraciones ${modified.join(", ")} ya se aplicaron pero su SQL cambió desde entonces ` +
          "(checksum distinto). No se aplicó ninguna migración. Nunca edites una migración ya publicada: añade una nueva.",
      );
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    const insert = db.prepare(`insert into ${LEDGER_TABLE} (id, checksum) values (?, ?)`);
    for (const migration of MIGRATIONS) {
      if (byId.has(migration.id)) {
        skipped.push(migration.id);
        continue;
      }
      db.exec(migration.sql);
      insert.run(migration.id, checksum(migration.sql));
      applied.push(migration.id);
    }

    db.exec("commit");
    return { applied, skipped };
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // The failure that matters is the original one.
    }
    throw error;
  }
}
