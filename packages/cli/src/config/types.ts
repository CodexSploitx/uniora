/**
 * Configuración explícita de UNIORA (docs/PROYECT.md §20). El proyecto
 * anfitrión exporta esto por defecto desde `uniora.config.mjs`.
 */
export interface UnioraDatabaseConfig {
  readonly provider: "postgresql";
  readonly url: string;
}

export interface UnioraAuthConfig {
  readonly provider: string;
}

export interface UnioraConfig {
  readonly database: UnioraDatabaseConfig;
  readonly auth?: UnioraAuthConfig;
}

/**
 * Identidad en runtime — solo existe para que `uniora.config.mjs` tenga
 * inferencia de tipos y autocompletado. La validación real (la que importa
 * para seguridad) ocurre en `validateConfig`, porque este objeto puede venir
 * de un archivo `.js` sin chequeo de tipos.
 */
export function defineConfig(config: UnioraConfig): UnioraConfig {
  return config;
}
