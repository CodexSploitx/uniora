import pg from "pg";

/**
 * Base de datos PROPIA para esta suite end-to-end, derivada de
 * `TEST_DATABASE_URL` — nunca `DATABASE_URL` (esa suele tener datos reales/de
 * demo del desarrollador) y nunca la base `uniora_test` que usa
 * `@uniora/postgres` para sus propios tests unitarios (correr ambas suites en
 * paralelo no debe pisarse). Mismo patrón que `packages/cli/src/test-database.ts`.
 */
const DATABASE_NAME = "uniora_test_e2e";

export function e2eDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL no está definida. Copia .env.example a .env en la raíz del repo " +
        "(ver docker-compose.yml) — esta suite crea su propia base de datos " +
        `("${DATABASE_NAME}") a partir de ese servidor, nunca reutiliza DATABASE_URL.`,
    );
  }
  const url = new URL(base);
  url.pathname = `/${DATABASE_NAME}`;
  return url.toString();
}

function adminUrl(): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL no está definida.");
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

/** Idempotente: crea `uniora_test_e2e` si todavía no existe. */
export async function ensureE2eDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [DATABASE_NAME]);
    if (existing.rowCount === 0) await createDatabaseTolerantly(client);
  } finally {
    await client.end();
  }
}

/**
 * Deja el schema `uniora` vacío antes de cada corrida, para que la suite
 * pueda re-ejecutarse sin acumular datos de una corrida anterior. `drop
 * schema ... cascade` en vez de truncar tabla por tabla: esta suite corre
 * `applyMigrations` desde cero cada vez, así que el schema no tiene por qué
 * existir todavía la primera vez.
 */
export async function resetUnioraSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    await client.query("drop schema if exists uniora cascade");
  } finally {
    await client.end();
  }
}

/**
 * vitest puede correr este archivo junto a otras suites del monorepo que
 * también crean su propia base en el mismo servidor — mismo manejo tolerante
 * a la carrera que ya usan `@uniora/postgres`/`@uniora/cli` en sus setups.
 */
async function createDatabaseTolerantly(client: pg.Client): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query(`create database "${DATABASE_NAME}"`);
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
