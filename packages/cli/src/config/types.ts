import type { ActorTokenProvider, InvitationConfig, MachineTokenProvider, PlatformConfig, ServerLimits, WebhooksConfig } from "@uniora/server";

/**
 * Configuración explícita de UNIORA (docs/PROYECT.md §20). El proyecto
 * anfitrión exporta esto por defecto desde `uniora.config.mjs`.
 */
export interface UnioraDatabaseConfig {
  /**
   * `postgresql`: `url` es una connection string (`postgresql://...`).
   * `sqlite`: `url` es `sqlite:<ruta>` (relativa al directorio del proyecto, o absoluta).
   */
  readonly provider: "postgresql" | "sqlite";
  readonly url: string;
}

export interface UnioraAuthConfig {
  readonly provider: string;
}

/**
 * Lo que `uniora server start` toma del archivo de configuración además de las banderas: el archivo es un módulo JS, así que
 * los secretos salen de `process.env` y las funciones (`invitations.sender`) se escriben como funciones. Las banderas
 * (`--default-provider`, `--trusted-proxy-hops`, `--read-only`) mandan sobre lo que diga el archivo. La validación fina es la de
 * `createUnioraServer` (falla cerrado con un mensaje que nombra la opción).
 */
export interface UnioraServerConfig {
  readonly defaultProvider?: string;
  readonly trustedProxyHops?: number;
  /** El/los addresses exactos del proxy que nombra `trustedProxyHops`: sin esto, `X-Forwarded-For` se confía desde CUALQUIER conexión directa. Ver `guides/server.md`. */
  readonly trustedProxies?: readonly string[];
  readonly readOnly?: boolean;
  readonly limits?: Partial<ServerLimits>;
  /** Proveedores de identidad cuyos tokens acepta `Uniora-Actor-Token`. */
  readonly actorTokens?: readonly ActorTokenProvider[];
  /** Tokens `client_credentials` de tu servidor OAuth, aceptados en `Authorization: Bearer` en lugar de una clave de API. */
  readonly machineTokens?: readonly MachineTokenProvider[];
  readonly requireVerifiedActors?: boolean;
  /** Un presupuesto de límite de tasa compartido entre instancias (necesita la tabla de límites, ya migrada). */
  readonly sharedRateLimit?: boolean;
  readonly invitations?: InvitationConfig;
  /** Rutas `/v1/platform`: el almacenamiento lo pone la CLI. */
  readonly platform?: Omit<PlatformConfig, "storage">;
  /** Webhooks: el almacenamiento y la salida (outbox) los pone la CLI. */
  readonly webhooks?: Omit<WebhooksConfig, "storage" | "outbox">;
}

export interface UnioraConfig {
  readonly database: UnioraDatabaseConfig;
  readonly auth?: UnioraAuthConfig;
  readonly server?: UnioraServerConfig;
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
