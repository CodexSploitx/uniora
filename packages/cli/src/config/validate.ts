import { SqliteUrlError, sqlitePathFromUrl } from "@uniora/sqlite";
import type { UnioraConfig, UnioraDatabaseConfig } from "./types.js";

export class UnioraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnioraConfigError";
  }
}

const SUPPORTED_DATABASE_PROVIDERS = ["postgresql", "sqlite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Una URL que no corresponde al proveedor declarado fallaría más tarde con un
 * error confuso del driver (o, peor, tocaría un archivo que nadie quiso). Se
 * rechaza aquí, nombrando ambas cosas.
 */
function checkUrlMatchesProvider(provider: UnioraDatabaseConfig["provider"], url: string, source: string): void {
  if (provider === "sqlite") {
    try {
      sqlitePathFromUrl(url);
    } catch (error) {
      if (error instanceof SqliteUrlError) {
        throw new UnioraConfigError(`Configuración inválida en ${source}: "database.url" para sqlite — ${error.message}`);
      }
      throw error;
    }
    return;
  }

  if (url.startsWith("sqlite:")) {
    throw new UnioraConfigError(
      `Configuración inválida en ${source}: "database.provider" es "postgresql" pero "database.url" es una URL de SQLite. ` +
        'Cambia el proveedor a "sqlite" o usa una connection string de PostgreSQL.',
    );
  }
}

/**
 * Valida en runtime la forma del `export default` de `uniora.config.mjs`.
 * TypeScript no protege esto: el archivo se importa dinámicamente y puede
 * venir de un `.js` sin chequeo de tipos, o simplemente tener un typo. Una
 * config con forma inesperada debe fallar aquí en vez de dejar pasar un
 * `provider`/`url` adivinado o `undefined` hacia el resto del CLI
 * (fail-closed, skill §1.1/§40/§42 — "unsupported provider" y config
 * incompleta están explícitamente en la lista de casos que deben denegar).
 */
export function validateConfig(config: unknown, source: string): UnioraConfig {
  if (!isRecord(config)) {
    throw new UnioraConfigError(
      `Configuración inválida en ${source}: se esperaba un objeto exportado por defecto ` +
        `(usa "export default defineConfig({...})").`,
    );
  }

  const database = config.database;
  if (!isRecord(database)) {
    throw new UnioraConfigError(`Configuración inválida en ${source}: falta "database".`);
  }

  const provider = database.provider;
  if (typeof provider !== "string" || !SUPPORTED_DATABASE_PROVIDERS.includes(provider as UnioraDatabaseConfig["provider"])) {
    throw new UnioraConfigError(
      `Proveedor de base de datos no soportado en ${source}: "${String(provider)}". ` +
        `Soportados en V1: ${SUPPORTED_DATABASE_PROVIDERS.join(", ")} (docs/PROYECT.md §16).`,
    );
  }

  const url = database.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new UnioraConfigError(
      `Configuración inválida en ${source}: "database.url" debe ser un string no vacío. ` +
        `Nunca lo hardcodees en el archivo de config — usa process.env.DATABASE_URL, ` +
        `definida en tu .env.`,
    );
  }

  const databaseProvider = provider as UnioraDatabaseConfig["provider"];
  checkUrlMatchesProvider(databaseProvider, url, source);

  const result: UnioraConfig = { database: { provider: databaseProvider, url } };

  if (config.auth === undefined) {
    return result;
  }

  const auth = config.auth;
  if (!isRecord(auth) || typeof auth.provider !== "string" || auth.provider.length === 0) {
    throw new UnioraConfigError(
      `Configuración inválida en ${source}: "auth.provider" debe ser un string no vacío cuando se define "auth".`,
    );
  }

  return { ...result, auth: { provider: auth.provider } };
}
