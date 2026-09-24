import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UnioraConfigError, validateConfig } from "./validate.js";
import type { UnioraConfig } from "./types.js";

const CONFIG_FILENAMES = ["uniora.config.mjs", "uniora.config.js"];

/**
 * Un nombre de entorno solo puede ser un token simple: se usa para construir
 * el nombre de archivo `.env.<nombre>`, así que no puede contener `/`, `..`
 * ni nada que escape del directorio del proyecto (path traversal).
 */
export const ENV_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface LoadConfigOptions {
  /** Ruta a un archivo de config explícito (relativa a `cwd`). Solo `.mjs`/`.js`. */
  readonly configPath?: string;
  /** Carga `.env.<envName>` — y **solo** ese — en vez de `.env`. */
  readonly envName?: string;
}

/**
 * Carga el `.env` del proyecto anfitrión si existe. Si no existe, no hacemos
 * nada aquí: la validación de la config es quien debe fallar con un mensaje
 * claro si `database.url` termina faltando — nunca asumimos una connection
 * string por defecto (mismo criterio que @uniora/postgres).
 *
 * Con `envName` se carga **únicamente** `.env.<envName>`, y su ausencia es un
 * error: si alguien pide `--env production`, caer en silencio al `.env` de
 * desarrollo haría que `migrate` toque la base equivocada. (Como
 * `process.loadEnvFile`, nunca pisa variables que ya estén en el entorno.)
 */
function loadDotEnv(cwd: string, envName: string | undefined): void {
  if (envName === undefined) {
    const envPath = resolve(cwd, ".env");
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
    return;
  }

  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new UnioraConfigError(`Nombre de entorno inválido: "${envName}".`);
  }
  const envPath = resolve(cwd, `.env.${envName}`);
  if (!existsSync(envPath)) {
    throw new UnioraConfigError(`No existe .env.${envName} en ${cwd} (pedido con --env ${envName}).`);
  }
  process.loadEnvFile(envPath);
}

export function findConfigFile(cwd: string): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = resolve(cwd, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return typeof value === "object" && value !== null && "default" in value;
}

function resolveConfigPath(cwd: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    // El archivo se ejecuta (`import()`): solo módulos JS, y debe existir — nunca se busca otro en su lugar.
    if (![".mjs", ".js"].includes(extname(explicit))) {
      throw new UnioraConfigError(`--config debe apuntar a un archivo .mjs o .js (recibido: "${explicit}").`);
    }
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new UnioraConfigError(`No existe el archivo de configuración ${path} (pedido con --config).`);
    }
    return path;
  }

  const found = findConfigFile(cwd);
  if (!found) {
    throw new UnioraConfigError(
      `No se encontró ${CONFIG_FILENAMES.join(" ni ")} en ${cwd}. Corre "uniora init" para crear uno.`,
    );
  }
  return found;
}

export async function loadConfig(cwd: string = process.cwd(), options: LoadConfigOptions = {}): Promise<UnioraConfig> {
  loadDotEnv(cwd, options.envName);

  const configPath = resolveConfigPath(cwd, options.configPath);

  const mod: unknown = await import(pathToFileURL(configPath).href);
  const exported = hasDefaultExport(mod) ? mod.default : undefined;

  return validateConfig(exported, configPath);
}
