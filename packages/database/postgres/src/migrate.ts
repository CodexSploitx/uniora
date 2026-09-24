import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { MIGRATION_0001_INIT } from "./migrations/0001_init.js";
import { MIGRATION_0002_AUDIT_LOGS } from "./migrations/0002_audit_logs.js";
import { MIGRATION_0003_IDENTITY_LINKS } from "./migrations/0003_identity_links.js";
import { MIGRATION_0004_CUSTOM_ROLES } from "./migrations/0004_custom_roles.js";
import { MIGRATION_0005_ORGANIZATION_SLUG } from "./migrations/0005_organization_slug.js";
import { MIGRATION_0006_ROLE_KEY } from "./migrations/0006_role_key.js";
import { MIGRATION_0007_FEATURE_REGISTRY } from "./migrations/0007_feature_registry.js";
import { MIGRATION_0008_PERMISSION_STANDARD } from "./migrations/0008_permission_standard.js";
import { MIGRATION_0009_AUDIT_LOGS_RECENT_INDEX } from "./migrations/0009_audit_logs_recent_index.js";
import { MIGRATION_0010_ORGANIZATIONS_CREATED_AT_INDEX } from "./migrations/0010_organizations_created_at_index.js";
import { MIGRATION_0011_MILLISECOND_PRECISION_TIMESTAMPS } from "./migrations/0011_millisecond_precision_timestamps.js";
import { MIGRATION_0012_FEATURES_ENABLED_INDEX } from "./migrations/0012_features_enabled_index.js";
import { MIGRATION_0013_DETAIL_INDEXES } from "./migrations/0013_detail_indexes.js";

interface Migration {
  readonly id: string;
  readonly sql: string;
}

/** Orden = orden de aplicación. Un `id` nunca se reutiliza ni se renombra: es la clave del ledger. */
const MIGRATIONS: readonly Migration[] = [
  { id: "0001_init", sql: MIGRATION_0001_INIT },
  { id: "0002_audit_logs", sql: MIGRATION_0002_AUDIT_LOGS },
  { id: "0003_identity_links", sql: MIGRATION_0003_IDENTITY_LINKS },
  { id: "0004_custom_roles", sql: MIGRATION_0004_CUSTOM_ROLES },
  { id: "0005_organization_slug", sql: MIGRATION_0005_ORGANIZATION_SLUG },
  { id: "0006_role_key", sql: MIGRATION_0006_ROLE_KEY },
  { id: "0007_feature_registry", sql: MIGRATION_0007_FEATURE_REGISTRY },
  { id: "0008_permission_standard", sql: MIGRATION_0008_PERMISSION_STANDARD },
  { id: "0009_audit_logs_recent_index", sql: MIGRATION_0009_AUDIT_LOGS_RECENT_INDEX },
  { id: "0010_organizations_created_at_index", sql: MIGRATION_0010_ORGANIZATIONS_CREATED_AT_INDEX },
  { id: "0011_millisecond_precision_timestamps", sql: MIGRATION_0011_MILLISECOND_PRECISION_TIMESTAMPS },
  { id: "0012_features_enabled_index", sql: MIGRATION_0012_FEATURES_ENABLED_INDEX },
  { id: "0013_detail_indexes", sql: MIGRATION_0013_DETAIL_INDEXES },
];

/**
 * Clave fija del advisory lock que serializa a dos procesos que migren a la
 * vez (dos despliegues, un CI y un dev): sin él ambos podrían ejecutar la
 * misma migración concurrentemente. Constante — nunca derivada de input.
 */
const MIGRATION_LOCK_KEY = 7263949162;

const LEDGER_TABLE = "uniora.schema_migrations";

const ENSURE_LEDGER = `
create schema if not exists uniora;
create table if not exists ${LEDGER_TABLE} (
  id text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
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
  /** ¿Existe ya la tabla `uniora.schema_migrations`? `false` en una base nueva o anterior al ledger. */
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

/** Ids de todas las migraciones que esta versión conoce, en orden. */
export function listMigrationIds(): string[] {
  return MIGRATIONS.map((migration) => migration.id);
}

/**
 * Estado del ledger. **Solo lectura**: nunca crea el schema ni la tabla, así
 * que es seguro contra una base que UNIORA aún no ha tocado (`migrate
 * --status`, `doctor`).
 */
export async function getMigrationStatus(pool: Pool): Promise<MigrationStatus> {
  const present = await pool.query<{ present: boolean }>(
    `select to_regclass('${LEDGER_TABLE}') is not null as present`,
  );

  if (!present.rows[0]?.present) {
    return { ledgerPresent: false, applied: [], pending: listMigrationIds(), modified: [], unknown: [] };
  }

  const rows = await pool.query<{ id: string; checksum: string; applied_at: Date }>(
    `select id, checksum, applied_at from ${LEDGER_TABLE} order by applied_at, id`,
  );

  const known = new Map(MIGRATIONS.map((migration) => [migration.id, checksum(migration.sql)]));
  const recorded = new Set(rows.rows.map((row) => row.id));

  return {
    ledgerPresent: true,
    applied: rows.rows.map((row) => ({ id: row.id, appliedAt: row.applied_at })),
    pending: MIGRATIONS.filter((migration) => !recorded.has(migration.id)).map((migration) => migration.id),
    modified: rows.rows.filter((row) => known.has(row.id) && known.get(row.id) !== row.checksum).map((row) => row.id),
    unknown: rows.rows.filter((row) => !known.has(row.id)).map((row) => row.id),
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
 * `uniora.schema_migrations`. Segura de correr repetidamente: lo ya
 * registrado no se re-ejecuta (y, además, cada migración sigue siendo
 * idempotente por sí misma — `create ... if not exists` — así que una base
 * anterior al ledger simplemente re-ejecuta todo una vez y queda registrada).
 *
 * - Un advisory lock serializa ejecuciones concurrentes.
 * - Cada migración corre en su propia transacción junto con su fila del
 *   ledger: o queda aplicada **y** registrada, o ninguna de las dos.
 * - Si el SQL de una migración ya registrada cambió (checksum distinto)
 *   lanza `MigrationError` **antes** de aplicar nada: no se sigue migrando
 *   sobre un historial que ya no coincide con el código.
 */
export async function applyMigrations(pool: Pool): Promise<MigrationRunResult> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(ENSURE_LEDGER);

      const recorded = await client.query<{ id: string; checksum: string }>(
        `select id, checksum from ${LEDGER_TABLE}`,
      );
      const byId = new Map(recorded.rows.map((row) => [row.id, row.checksum]));

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
      for (const migration of MIGRATIONS) {
        if (byId.has(migration.id)) {
          skipped.push(migration.id);
          continue;
        }
        await client.query("begin");
        try {
          await client.query(migration.sql);
          await client.query(`insert into ${LEDGER_TABLE} (id, checksum) values ($1, $2)`, [
            migration.id,
            checksum(migration.sql),
          ]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
        applied.push(migration.id);
      }

      return { applied, skipped };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
