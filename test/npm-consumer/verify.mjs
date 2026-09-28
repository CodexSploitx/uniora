#!/usr/bin/env node
// Consumidor externo real de UNIORA — ver docs/testing.md.
//
// A diferencia de test/integration (que usa el código fuente del monorepo
// vía workspace:*), esta carpeta está deliberadamente FUERA del workspace
// de pnpm: sus dependencias (`@uniora/cli`, `@uniora/core`, `@uniora/postgres`)
// se instalan con `npm install` desde el registro público de npm, exactamente
// como lo haría cualquier usuario del proyecto. El objetivo es comprobar que
// lo que de verdad se publica (dist/, exports, el binario de la CLI) funciona
// de punta a punta — no solo el código fuente.
//
// Uso:
//   cd test/npm-consumer
//   cp .env.example .env   # primera vez
//   npm install             # primera vez, o tras cambiar de versión
//   npm run verify

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const cwd = dirname(fileURLToPath(import.meta.url));
const envPath = join(cwd, ".env");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function step(name) {
  console.log(`\n— ${name} —`);
}

if (!existsSync(envPath)) {
  fail(
    "Falta test/npm-consumer/.env. Copia .env.example a .env " +
      "(apunta a una base de datos PROPIA, ver el comentario del archivo).",
  );
}
process.loadEnvFile(envPath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL no está definida en test/npm-consumer/.env.");
if (!databaseUrl.includes("uniora_npm_consumer")) {
  fail(
    "DATABASE_URL no apunta a 'uniora_npm_consumer' — esta verificación resetea el " +
      "schema uniora.* del target antes de correr, y por seguridad se niega a hacerlo " +
      "contra cualquier otra base (podría ser la de desarrollo real). Usa el .env.example tal cual.",
  );
}

function runCli(args) {
  const output = execFileSync("npx", ["uniora", ...args, "--json"], {
    cwd,
    env: process.env,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

async function ensureDatabaseExists() {
  const target = new URL(databaseUrl);
  const databaseName = target.pathname.slice(1);
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [databaseName]);
    if (existing.rowCount === 0) {
      await client.query(`create database "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

async function resetSchema() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("drop schema if exists uniora cascade");
  } finally {
    await client.end();
  }
}

step("Preparando la base de datos propia (uniora_npm_consumer)");
await ensureDatabaseExists();
await resetSchema();

step("npx uniora init (genera uniora.config.mjs si falta — el binario publicado real)");
execFileSync("npx", ["uniora", "init"], { cwd, env: process.env, stdio: "inherit" });
if (!existsSync(join(cwd, "uniora.config.mjs"))) {
  fail("uniora init no generó uniora.config.mjs.");
}

step("npx uniora doctor (antes de migrar — se espera que avise que falta el schema)");
console.log(JSON.stringify(runCli(["doctor"]), null, 2));

step("npx uniora migrate (aplica las migraciones reales contra Postgres real)");
const migrateResult = runCli(["migrate"]);
console.log(JSON.stringify(migrateResult, null, 2));
if (!migrateResult.ok) fail("uniora migrate no terminó en ok:true.");

step("npx uniora doctor (después de migrar — debe estar todo en verde)");
const doctorResult = runCli(["doctor"]);
console.log(JSON.stringify(doctorResult, null, 2));
if (!doctorResult.ok) fail("uniora doctor no terminó en ok:true tras migrar.");

step("Flujo real de autorización con @uniora/core + @uniora/postgres (paquetes publicados, desde node_modules)");
const { createPostgresStorage } = await import("@uniora/postgres");
const { createAuthorizationEngine, createOrganizationWithOwner } = await import("@uniora/core");

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const storage = createPostgresStorage(pool);
  const engine = createAuthorizationEngine(storage);

  await storage.permissions.register({ key: "vehicles.delete", name: "Eliminar vehículos" });

  const ownerIdentity = { provider: "npm-consumer-check", subject: "owner" };
  const outsiderIdentity = { provider: "npm-consumer-check", subject: "outsider" };

  const { organization } = await createOrganizationWithOwner(storage, {
    organizationId: "npm-consumer-org",
    organizationName: "npm consumer check",
    ownerRoleId: "npm-consumer-owner-role",
    membershipId: "npm-consumer-owner-membership",
    ownerIdentity,
  });

  const ownerCan = await engine.can({
    identity: ownerIdentity,
    organizationId: organization.id,
    permission: "vehicles.delete",
  });
  const outsiderCan = await engine.can({
    identity: outsiderIdentity,
    organizationId: organization.id,
    permission: "vehicles.delete",
  });

  if (ownerCan !== true) fail("El Owner debería tener acceso (bypass) y no lo tuvo.");
  if (outsiderCan !== false) fail("Una identidad sin membership obtuvo acceso — fallo de aislamiento real.");

  console.log("✓ Owner autorizado (bypass real), identidad sin membership denegada (fail-closed).");
} finally {
  await pool.end();
}

console.log("\n✓ Todo en verde: @uniora/cli, @uniora/core y @uniora/postgres funcionan como paquetes publicados reales.\n");
