import pg from "pg";

/**
 * Helper de tests: una base de datos PROPIA (derivada de `TEST_DATABASE_URL`,
 * nunca `DATABASE_URL`) para probar contra un schema `uniora` vacío sin tocar
 * los datos de demo del desarrollador. Cada archivo de test usa un nombre
 * distinto porque vitest corre los archivos en paralelo.
 */
export function testDatabaseUrl(database: string): string | undefined {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function ensureDatabase(database: string): Promise<string> {
  const target = testDatabaseUrl(database);
  const admin = testDatabaseUrl("postgres");
  if (!target || !admin) throw new Error("TEST_DATABASE_URL no está definida (ver .env.example).");

  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [database]);
    if (existing.rowCount === 0) await createDatabaseTolerantly(client, database);
  } finally {
    await client.end();
  }
  return target;
}

export async function resetUnioraSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("drop schema if exists uniora cascade");
  } finally {
    await client.end();
  }
}

/**
 * Los archivos de test corren en paralelo: en un servidor vacío (CI) varios
 * ejecutan `create database` a la vez. 42P04/23505 = ya la creó otro (bien);
 * 55006 = `template1` ocupado por otro CREATE DATABASE (reintentar).
 */
async function createDatabaseTolerantly(client: pg.Client, database: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query(`create database "${database}"`);
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
