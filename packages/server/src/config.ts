import type { ApiCredentialStorage, AuthorizationEngineOptions, InvitationServiceOptions, PolicyServiceOptions, UnioraStorage } from "@uniora/core";
import { isReservedIdentityProvider } from "@uniora/core";
import { createJsonLogger } from "./logger.js";
import type { Logger } from "./logger.js";

/** The server refuses to start in a way that would be unsafe or ambiguous. Always fail closed. */
export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

export interface ServerLimits {
  /** Largest request body, in bytes. */
  maxBodyBytes: number;
  /** Items per page when the caller does not say; and the most it may ask for. */
  defaultPageSize: number;
  maxPageSize: number;
  /** Checks in one `check:batch`. */
  maxBatchChecks: number;
  /** A request that takes longer is answered 503 and its result is discarded. */
  requestTimeoutMs: number;
  /** Per API key: steady requests per second and burst. */
  ratePerSecond: number;
  rateBurst: number;
  /** In-flight requests per API key, and in the whole process. */
  maxConcurrencyPerKey: number;
  maxInFlight: number;
  /** Failed authentications from one source address per minute before it is refused. */
  authFailuresPerMinute: number;
  /** Node's own slow-client defences. */
  headersTimeoutMs: number;
  requestBodyTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxHeaderBytes: number;
}

export const DEFAULT_LIMITS: Readonly<ServerLimits> = Object.freeze({
  maxBodyBytes: 64 * 1024,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxBatchChecks: 50,
  requestTimeoutMs: 5_000,
  ratePerSecond: 50,
  rateBurst: 100,
  maxConcurrencyPerKey: 20,
  maxInFlight: 1_000,
  authFailuresPerMinute: 20,
  headersTimeoutMs: 10_000,
  requestBodyTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxHeaderBytes: 8 * 1024,
});

export type InvitationConfig = Omit<InvitationServiceOptions, "storage" | "engine"> & {
  /**
   * Return the secret accept link in the response of `invite` and `resend` (default `false`). Turn it on only if YOUR backend sends
   * the e-mail itself; otherwise the link is for `sender` alone and never travels back to the caller.
   */
  includeAcceptUrl?: boolean;
};

export interface UnioraServerOptions {
  /** The organization data. Reads and decisions go through it. */
  storage: UnioraStorage;
  /**
   * The API credentials, ideally over a database user that can only READ clients and keys (and refresh `last_used_at`):
   * the server never creates or changes a credential, and no route can.
   */
  credentials: Pick<ApiCredentialStorage, "apiClients" | "apiKeys">;
  /**
   * The identity provider label used when a request sends only a `subject`. An opaque label chosen by you (`"main"`); it need
   * not name your auth vendor. Set it once and never change it once data exists. Without it, a request must always send the
   * provider.
   */
  defaultProvider?: string;
  limits?: Partial<ServerLimits>;
  /**
   * Turns on the invitation routes. The accept link and the way an e-mail is sent are YOURS: UNIORA only builds the link from the
   * secret token (`acceptUrl`) and hands it to `sender`. Without it the invitation routes answer 501 `invitations_not_configured`.
   */
  invitations?: InvitationConfig;
  /** Passed to the policy service the delegated policy routes use (`requireSeparateActivator`). */
  policies?: Omit<PolicyServiceOptions, "storage" | "engine">;
  engine?: AuthorizationEngineOptions;
  /** Refuse every write with 503 `read_only` (during a migration or an incident). */
  readOnly?: boolean;
  /**
   * How many reverse proxies sit in front of the server. `0` (default) trusts only the socket address. With `n`, the source
   * address is the n-th from the right in `X-Forwarded-For`, which is what your proxy appended; never trust more hops than you run.
   */
  trustedProxyHops?: number;
  logger?: Logger;
  /** The clock, for tests. */
  now?: () => Date;
}

export interface ResolvedConfig {
  readonly storage: UnioraStorage;
  readonly credentials: Pick<ApiCredentialStorage, "apiClients" | "apiKeys">;
  readonly defaultProvider: string | undefined;
  readonly limits: Readonly<ServerLimits>;
  readonly engine: AuthorizationEngineOptions | undefined;
  readonly invitations: InvitationConfig | undefined;
  readonly policies: Omit<PolicyServiceOptions, "storage" | "engine"> | undefined;
  readonly readOnly: boolean;
  readonly trustedProxyHops: number;
  readonly logger: Logger;
  readonly now: () => Date;
}

const PROVIDER_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function positiveInt(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new ServerConfigError(`limits.${name} must be an integer from 1 to ${max} (got ${String(value)}).`);
}

export function resolveConfig(options: UnioraServerOptions): ResolvedConfig {
  if (!options || typeof options !== "object") throw new ServerConfigError("createUnioraServer needs an options object.");
  if (!options.storage) throw new ServerConfigError("`storage` is required.");
  if (!options.credentials?.apiClients || !options.credentials?.apiKeys) {
    throw new ServerConfigError("`credentials` is required: without API keys the server would have nobody to authenticate.");
  }

  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const unknown of Object.keys(options.limits ?? {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, unknown)) throw new ServerConfigError(`Unknown limit "${unknown}".`);
  }
  positiveInt("maxBodyBytes", limits.maxBodyBytes, 8 * 1024 * 1024);
  positiveInt("defaultPageSize", limits.defaultPageSize, 1000);
  positiveInt("maxPageSize", limits.maxPageSize, 1000);
  positiveInt("maxBatchChecks", limits.maxBatchChecks, 1000);
  positiveInt("requestTimeoutMs", limits.requestTimeoutMs, 120_000);
  positiveInt("ratePerSecond", limits.ratePerSecond, 100_000);
  positiveInt("rateBurst", limits.rateBurst, 100_000);
  positiveInt("maxConcurrencyPerKey", limits.maxConcurrencyPerKey, 100_000);
  positiveInt("maxInFlight", limits.maxInFlight, 1_000_000);
  positiveInt("authFailuresPerMinute", limits.authFailuresPerMinute, 100_000);
  positiveInt("headersTimeoutMs", limits.headersTimeoutMs, 300_000);
  positiveInt("requestBodyTimeoutMs", limits.requestBodyTimeoutMs, 300_000);
  positiveInt("keepAliveTimeoutMs", limits.keepAliveTimeoutMs, 300_000);
  positiveInt("maxHeaderBytes", limits.maxHeaderBytes, 1024 * 1024);
  if (limits.defaultPageSize > limits.maxPageSize) throw new ServerConfigError("limits.defaultPageSize cannot exceed limits.maxPageSize.");

  const provider = options.defaultProvider;
  if (provider !== undefined) {
    if (!PROVIDER_LABEL.test(provider)) throw new ServerConfigError("`defaultProvider` must be 1 to 64 characters from A-Z a-z 0-9 _ . : -.");
    if (isReservedIdentityProvider(provider)) throw new ServerConfigError(`\`defaultProvider\` cannot be "${provider}": that label is reserved for UNIORA's own principals.`);
  }

  const hops = options.trustedProxyHops ?? 0;
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new ServerConfigError("`trustedProxyHops` must be an integer from 0 to 10.");

  return Object.freeze({
    storage: options.storage,
    credentials: options.credentials,
    defaultProvider: provider,
    limits: Object.freeze(limits),
    engine: options.engine,
    invitations: options.invitations,
    policies: options.policies,
    readOnly: options.readOnly === true,
    trustedProxyHops: hops,
    logger: options.logger ?? createJsonLogger(),
    now: options.now ?? (() => new Date()),
  });
}

/** Whether `host` only listens on this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
