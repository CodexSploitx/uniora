import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Carga .env de la raíz del repo si existe, para los tests de integración
// que usan la misma DATABASE_URL que @uniora/postgres. Si no existe, no
// hacemos nada aquí: esos tests deben fallar con un mensaje claro pidiendo
// configurarlo, nunca asumir una DATABASE_URL por defecto.
const envPath = resolve(import.meta.dirname, "../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
