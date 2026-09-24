import { UsageError, type OptionSpec, type ParsedFlags } from "./args.js";
import { ENV_NAME_PATTERN } from "../config/loader.js";

/** Opciones que aceptan todos los comandos que cargan la configuración. */
export interface CommonOptions {
  readonly json?: boolean;
  /** Ruta a un archivo de config distinto de `uniora.config.mjs`/`.js` (relativa al cwd). */
  readonly configPath?: string;
  /** Nombre de entorno: carga `.env.<nombre>` (y **solo** ese) en lugar de `.env`. */
  readonly envName?: string;
}

export const COMMON_SPEC: OptionSpec = { help: "boolean", config: "string", env: "string" };
export const JSON_SPEC: OptionSpec = { ...COMMON_SPEC, json: "boolean" };

export function commonFromFlags(flags: ParsedFlags): CommonOptions {
  const envName = flags.env as string | undefined;
  if (envName !== undefined && !ENV_NAME_PATTERN.test(envName)) {
    throw new UsageError(
      `--env "${envName}" no es válido: usa solo minúsculas, dígitos, "-" o "_" (p. ej. production, staging).`,
    );
  }
  return {
    json: flags.json === true,
    configPath: flags.config as string | undefined,
    envName,
  };
}
