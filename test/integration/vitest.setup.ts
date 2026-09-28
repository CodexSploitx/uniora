import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureE2eDatabase } from "./src/test-database.js";

// Carga .env de la raíz del repo si existe (mismo criterio que el resto del
// monorepo: nunca una URL por defecto, createTestPool-equivalente debe fallar
// ruidosamente si falta).
const envPath = resolve(import.meta.dirname, "../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (process.env.TEST_DATABASE_URL) {
  await ensureE2eDatabase();
}
