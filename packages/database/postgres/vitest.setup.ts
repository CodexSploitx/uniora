import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

// Carga .env de la raíz del repo si existe. Si no existe, no hacemos nada
// aquí: createTestPool() es quien debe fallar con un mensaje claro pidiendo
// configurarlo (nunca asumimos una DATABASE_URL/TEST_DATABASE_URL por defecto).
const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (process.env.TEST_DATABASE_URL) {
  await ensureDatabaseExists(process.env.TEST_DATABASE_URL);
}

/**
 * Idempotently creates the database `TEST_DATABASE_URL` points to, if it
 * doesn't already exist yet — Postgres has no `create database if not
 * exists`, so this checks `pg_database` first via the server's `postgres`
 * maintenance database. Lets a fresh clone run
 * `pnpm --filter @uniora/postgres test` without a manual `createdb` step,
 * same "just works" idempotency the project's own migrations follow.
 */
async function ensureDatabaseExists(connectionString: string): Promise<void> {
  const target = new URL(connectionString);
  const databaseName = target.pathname.slice(1);
  if (!databaseName) return;

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [databaseName]);
    if (existing.rowCount === 0) {
      // Database identifiers can't be parameterized. Safe here: `databaseName`
      // only ever comes from TEST_DATABASE_URL in the developer's own local
      // .env, never from untrusted input — quotes are still escaped defensively.
      await createDatabaseTolerantly(client, databaseName);
    }
  } finally {
    await client.end();
  }
}

/**
 * vitest runs every test file's setup in parallel, so on a fresh server
 * (CI) several of them see "doesn't exist" at once and race to create it:
 * the loser gets 42P04/23505 (already exists — fine, it's what we wanted) or
 * 55006 (`template1` is briefly busy because another CREATE DATABASE is
 * running — retry). Found by the first GitHub Actions run; it never showed up
 * locally because the database already existed.
 */
async function createDatabaseTolerantly(client: Client, databaseName: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query(`create database "${databaseName.replace(/"/g, '""')}"`);
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
