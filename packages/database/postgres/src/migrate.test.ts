import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus, listMigrationIds, MigrationError } from "./migrate.js";

/**
 * Base de datos PROPIA de este archivo (no `uniora_test`): vitest corre los
 * archivos en paralelo y `storage.test.ts` trunca/usa `uniora.*` en
 * `uniora_test`, mientras que estos tests borran el schema entero para
 * probar el arranque desde cero.
 */
const DATABASE_NAME = "uniora_test_migrations";

function urlFor(database: string): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL no está definida (ver .env.example).");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [DATABASE_NAME]);
    if (existing.rowCount === 0) await createDatabaseTolerantly(admin, DATABASE_NAME);
  } finally {
    await admin.end();
  }
}

/** Ver vitest.setup.ts: varios archivos crean bases a la vez en un servidor vacío (CI). */
async function createDatabaseTolerantly(admin: Client, name: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`create database "${name}"`);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "42P04" || code === "23505") return;
      if (code === "55006" && attempt < 6) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

describe("migration ledger", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureDatabase();
    pool = new Pool({ connectionString: urlFor(DATABASE_NAME) });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("drop schema if exists uniora cascade");
  });

  it("status es de solo lectura: no crea nada en una base virgen y reporta todo pendiente", async () => {
    const status = await getMigrationStatus(pool);

    expect(status.ledgerPresent).toBe(false);
    expect(status.pending).toEqual(listMigrationIds());
    expect(status.applied).toEqual([]);

    const schema = await pool.query("select to_regnamespace('uniora') as schema");
    expect(schema.rows[0].schema).toBeNull();
  });

  it("aplica todo la primera vez, lo registra, y la segunda vez no re-ejecuta nada", async () => {
    const first = await applyMigrations(pool);
    expect(first.applied).toEqual(listMigrationIds());
    expect(first.skipped).toEqual([]);

    const status = await getMigrationStatus(pool);
    expect(status).toMatchObject({ ledgerPresent: true, pending: [], modified: [], unknown: [] });
    expect(status.applied.map((migration) => migration.id)).toEqual(listMigrationIds());

    const second = await applyMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(listMigrationIds());
  });

  it("una base anterior al ledger (schema sin ledger) se re-migra una vez y queda registrada", async () => {
    await applyMigrations(pool);
    await pool.query("drop table uniora.schema_migrations");

    expect((await getMigrationStatus(pool)).ledgerPresent).toBe(false);

    const result = await applyMigrations(pool);
    expect(result.applied).toEqual(listMigrationIds());
    expect((await getMigrationStatus(pool)).pending).toEqual([]);
  });

  it("detecta una migración modificada tras aplicarse y se niega a seguir sin aplicar nada", async () => {
    await applyMigrations(pool);
    const last = listMigrationIds().at(-1) as string;
    await pool.query("delete from uniora.schema_migrations where id = $1", [last]);
    await pool.query("update uniora.schema_migrations set checksum = 'tampered' where id = '0002_audit_logs'");

    const status = await getMigrationStatus(pool);
    expect(status.modified).toEqual(["0002_audit_logs"]);
    expect(status.pending).toEqual([last]);

    await expect(applyMigrations(pool)).rejects.toThrow(MigrationError);

    // Falla cerrado: la migración pendiente NO se aplicó a pesar de estar pendiente.
    const after = await getMigrationStatus(pool);
    expect(after.pending).toEqual([last]);
  });

  it("reporta migraciones desconocidas (base más nueva que el código) sin bloquear", async () => {
    await applyMigrations(pool);
    await pool.query("insert into uniora.schema_migrations (id, checksum) values ('9999_from_the_future', 'x')");

    const status = await getMigrationStatus(pool);
    expect(status.unknown).toEqual(["9999_from_the_future"]);
    expect(status.modified).toEqual([]);

    await expect(applyMigrations(pool)).resolves.toMatchObject({ applied: [] });
  });

  it("dos migradores concurrentes no ejecutan la misma migración dos veces", async () => {
    const [a, b] = await Promise.all([applyMigrations(pool), applyMigrations(pool)]);

    expect(a.applied.length + b.applied.length).toBe(listMigrationIds().length);
    const rows = await pool.query("select count(*)::int as n from uniora.schema_migrations");
    expect(rows.rows[0].n).toBe(listMigrationIds().length);
  });
});
