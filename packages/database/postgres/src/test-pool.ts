import { Pool } from "pg";

/**
 * Connection used by this package's own test suite.
 *
 * Deliberately a SEPARATE database from `DATABASE_URL` — this suite's
 * `beforeEach` truncates every `uniora.*` table for isolation between
 * tests, which would otherwise wipe out real data every time the tests
 * run (e.g. Studio demo data seeded into whatever `DATABASE_URL` points
 * to — this bit the project's own demo data more than once before this
 * split existed). `TEST_DATABASE_URL` never falls back to `DATABASE_URL`
 * and never has a hardcoded default: it must come from `.env` (see
 * `.env.example` in the repo root), and a missing value fails loudly
 * instead of silently truncating whatever `DATABASE_URL` happens to
 * point to.
 */
export function createTestPool(): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL no está definida. Copia .env.example a .env en la raíz del repo " +
        "y ajusta la cadena de conexión a una base de datos DISTINTA de DATABASE_URL " +
        "(este paquete trunca sus tablas entre tests — ver docker-compose.yml).",
    );
  }

  return new Pool({ connectionString });
}
