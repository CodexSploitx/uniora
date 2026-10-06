import { Pool } from "pg";
import { applyMigrations, getMigrationStatus } from "@uniora/postgres";
import { describeDatabaseTarget, type CheckResult } from "../cli/output.js";
import type { DatabaseDriver } from "./types.js";

/** Versión mayor mínima de PostgreSQL con soporte upstream (14 sale de soporte en nov-2026). */
const MIN_SUPPORTED_POSTGRES_MAJOR = 14;

function postgresMajor(serverVersionNum: string): number {
  return Math.floor(Number(serverVersionNum) / 10000);
}

export function createPostgresDriver(connectionString: string): DatabaseDriver {
  const pool = new Pool({ connectionString });
  const target = describeDatabaseTarget(connectionString);

  return {
    provider: "postgresql",
    target,

    async probe() {
      await pool.query("select 1");
      return { severity: "ok", message: target ? `conectado a ${target}` : "conectado" };
    },

    migrationStatus: () => getMigrationStatus(pool),
    applyMigrations: () => applyMigrations(pool),

    async engineChecks() {
      const version = await pool.query<{ server_version: string; server_version_num: string }>(
        "select current_setting('server_version') as server_version, current_setting('server_version_num') as server_version_num",
      );
      const row = version.rows[0];
      const major = row ? postgresMajor(row.server_version_num) : 0;
      return [
        major >= MIN_SUPPORTED_POSTGRES_MAJOR
          ? { name: "PostgreSQL", severity: "ok", message: `${row?.server_version} (soportada)` }
          : {
              name: "PostgreSQL",
              severity: "warn",
              message: `${row?.server_version ?? "versión desconocida"}: por debajo de la ${MIN_SUPPORTED_POSTGRES_MAJOR}, fuera de soporte upstream. Actualiza cuando puedas.`,
            },
      ];
    },

    async ownerInvariant(): Promise<CheckResult> {
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
      return ownerResult(result.rows.map((row) => row.id), Number(result.rows[0]?.total ?? 0));
    },

    close: () => pool.end(),
  };
}

/**
 * Invariante "toda organización tiene ≥ 1 owner" (skill §11). Se garantiza al
 * crear con `createOrganizationWithOwner` y al no poder quitar el último
 * owner — pero una organización creada con `organizations.create()` a secas
 * (o insertada a mano en SQL) puede no tenerlo. Es `warn`, no `fail`: hay
 * usos legítimos (seeds, tests) y no es un fallo de la instalación, pero
 * quien administre debe saberlo.
 */
export function ownerResult(sampleIds: readonly string[], total: number): CheckResult {
  if (sampleIds.length === 0) {
    return { name: "Owners", severity: "ok", message: "todas las organizaciones tienen al menos un owner" };
  }
  return {
    name: "Owners",
    severity: "warn",
    message: `${total} organización(es) sin ningún miembro con el role Owner (${sampleIds.join(", ")}${total > sampleIds.length ? ", …" : ""}). Créalas con createOrganizationWithOwner() o asigna el Owner role a un miembro.`,
  };
}
