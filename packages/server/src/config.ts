import { isIP } from "node:net";
import type { ApiCredentialStorage, AuthorizationEngineOptions, InvitationServiceOptions, OutboxRepository, PlatformEngineOptions, PlatformStorage, PolicyServiceOptions, UnioraStorage, WebhookStorage, WebhookUrlPolicy } from "@uniora/core";
import { isReservedIdentityProvider } from "@uniora/core";
import { resolveActorTokenProviders } from "./actor-token.js";
import type { ActorTokenProvider, ResolvedProvider } from "./actor-token.js";
import { resolveMachineTokenProviders } from "./machine-token.js";
import type { MachineTokenProvider, ResolvedMachineProviders } from "./machine-token.js";
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

export interface PlatformConfig {
  /** The platform scope (staff roles and members, its audit log). Its own tables, like the credentials. */
  storage: PlatformStorage;
  /**
   * The `provider` labels of `actorTokens` whose tokens may administer the platform. Required: platform operators are people of
   * YOUR staff identity provider, and a customer-facing provider must not be able to reach this. A separate provider for staff is best.
   */
  providers: readonly string[];
  /**
   * What counts as a recent re-authentication, read from the operator's own token (`auth_time`, `amr`, `acr`): every change is
   * refused with `428 platform_step_up_required` unless the sign-in is recent enough and used a second factor. Reads never need it.
   */
  stepUp?: {
    /** The longest ago the operator signed in. Default 300 s, at most 3600. */
    maxAgeSeconds?: number;
    /** The sign-in used a second factor (`amr` contains `mfa`). Default `true`. */
    requireMfa?: boolean;
    /** The least assurance level (`acrLevels` of the provider) the sign-in reached. Default none. */
    minAssuranceLevel?: number;
  };
  /** The organization permission keys support access may open (see `PlatformServiceOptions`). REQUIRED: there is no "any permission" default; an empty list means support access can open none. */
  supportGrantablePermissions: readonly string[];
  engine?: PlatformEngineOptions;
}

export interface ResolvedPlatform {
  readonly storage: PlatformStorage;
  readonly providers: ReadonlySet<string>;
  readonly stepUp: { readonly maxAgeSeconds: number; readonly requireMfa: boolean; readonly minAssuranceLevel: number | undefined };
  readonly supportGrantablePermissions: readonly string[];
  readonly engine: PlatformEngineOptions | undefined;
}

export interface WebhooksConfig {
  /** The webhook endpoints and deliveries (their own scope: the endpoint rows hold the signing secrets). */
  storage: WebhookStorage;
  /** The events to send. Defaults to the outbox of `storage` (the organization storage), which must have been wrapped with `createAuditedStorage(..., { outbox: true })` for changes to produce events. The dispatcher is its consumer. */
  outbox?: OutboxRepository;
  /** Development receivers only: `allowInsecureHttp` and `allowPrivateNetworks`. Never both on in production. */
  urlPolicy?: WebhookUrlPolicy;
  /** Run the dispatcher inside `listen()` (default `true`). Turn it off to run it somewhere else (`uniora webhooks run`) and keep this process for requests. */
  run?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  disableAfterFailures?: number;
  /** ...and at least this long without a delivery (default 60). */
  disableAfterMinutes?: number;
  pollIntervalMs?: number;
  retainDeliveredDays?: number;
}

export interface UnioraServerOptions {
  /** The organization data. Reads and decisions go through it. */
  storage: UnioraStorage;
  /**
   * The API credentials, ideally over a database user that can only READ clients and keys (and refresh `last_used_at`):
   * the server never creates or changes a credential, and no route can.
   */
  credentials: Pick<ApiCredentialStorage, "apiClients" | "apiKeys"> & Partial<Pick<ApiCredentialStorage, "rateLimits">>;
  /**
   * The identity provider label used when a request sends only a `subject`. An opaque label chosen by you (`"main"`); it need
   * not name your auth vendor. Set it once and never change it once data exists. Without it, a request must always send the
   * provider.
   */
  defaultProvider?: string;
  limits?: Partial<ServerLimits>;
  /**
   * The identity providers whose end-user tokens the server accepts in `Uniora-Actor-Token`, each with its issuer, audience, pinned
   * algorithms and keys (`jwksUri`, `jwks` or an `HS*` `secret`). With one, a delegated call can prove who it speaks for instead of
   * asserting it, so a leaked API key can no longer speak for an arbitrary user. See `guides/server.md`.
   */
  actorTokens?: readonly ActorTokenProvider[];
  /**
   * OAuth 2.0 `client_credentials` access tokens from YOUR identity provider (Auth0 machine-to-machine, Okta, Azure AD, Keycloak...),
   * accepted in `Authorization: Bearer` in place of an UNIORA API key. Each provider says which API client each machine (token subject)
   * is; the client's scopes and organization allowlist stay the ceiling, and the token's own `scope` can only narrow them. Nothing to
   * distribute or rotate on the UNIORA side, and disabling the API client cuts the machine off at once. Use an audience of its own
   * (never the one of `actorTokens`). See `guides/server.md`.
   */
  machineTokens?: readonly MachineTokenProvider[];
  /**
   * Refuse asserted actors (`Uniora-Actor-Subject`) on delegated calls: only a verified token is accepted. Needs `actorTokens`. This
   * is what makes a leaked key unable to impersonate anybody; turn it on once your backends send tokens.
   */
  requireVerifiedActors?: boolean;
  /**
   * Turns on the invitation routes. The accept link and the way an e-mail is sent are YOURS: UNIORA only builds the link from the
   * secret token (`acceptUrl`) and hands it to `sender`. Without it the invitation routes answer 501 `invitations_not_configured`.
   */
  invitations?: InvitationConfig;
  /** Passed to the policy service the delegated policy routes use (`requireSeparateActivator`). */
  policies?: Omit<PolicyServiceOptions, "storage" | "engine">;
  engine?: AuthorizationEngineOptions;
  /**
   * Share the rate limit between instances: one budget per API key kept in the credential storage (`credentials.rateLimits`), so N
   * instances allow the configured rate together instead of N times that. Needs the credential storage to be writable for it.
   * If the storage fails, each instance limits on its own meanwhile.
   */
  sharedRateLimit?: boolean;
  /**
   * Turns on the platform routes (`/v1/platform/...`, scope `platform:admin`). They are only ever called with the operator's own
   * verified token and a recent second factor; without this option they answer 501 `platform_not_configured`.
   */
  platform?: PlatformConfig;
  /**
   * Sends the events of the outbox to webhook endpoints (signed, retried, with an SSRF guard). Managed from Studio and the CLI, never
   * from an API route: an endpoint receives the events of EVERY organization.
   */
  webhooks?: WebhooksConfig;
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
  readonly credentials: Pick<ApiCredentialStorage, "apiClients" | "apiKeys"> & Partial<Pick<ApiCredentialStorage, "rateLimits">>;
  readonly defaultProvider: string | undefined;
  readonly limits: Readonly<ServerLimits>;
  readonly engine: AuthorizationEngineOptions | undefined;
  readonly actorProviders: readonly ResolvedProvider[];
  readonly machineProviders: ResolvedMachineProviders;
  readonly requireVerifiedActors: boolean;
  readonly invitations: InvitationConfig | undefined;
  readonly policies: Omit<PolicyServiceOptions, "storage" | "engine"> | undefined;
  readonly sharedRateLimit: boolean;
  readonly platform: ResolvedPlatform | undefined;
  readonly webhooks: WebhooksConfig | undefined;
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
  // 199, not 1000: the repositories serve at most 200 rows a page and the routes ask for one more to know whether a next page exists.
  positiveInt("maxPageSize", limits.maxPageSize, 199);
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

  if (options.sharedRateLimit === true && !options.credentials.rateLimits) {
    throw new ServerConfigError("`sharedRateLimit` needs `credentials.rateLimits`: use a credential storage that keeps the shared bucket (memory, SQLite or PostgreSQL).");
  }
  if (options.engine?.onDecision !== undefined) {
    throw new ServerConfigError(
      "`engine.onDecision` is not supported by the server: the identity and target of a decision come from the caller, so a key that only holds `check` could write audit rows under any name. Audit decisions in your own backend.",
    );
  }
  const actorProviders = resolveActorTokenProviders(options.actorTokens);
  const machineProviders = resolveMachineTokenProviders(options.machineTokens);
  for (const machine of machineProviders.providers) {
    const clash = actorProviders.find((actor) => actor.issuer === machine.issuer && machine.audiences.some((audience) => actor.audiences.includes(audience)));
    if (clash) throw new ServerConfigError(`machineTokens and actorTokens accept the same issuer with a shared audience ("${machine.issuer}"): give machine tokens an audience of their own, or a user token could be mistaken for a machine one.`);
  }
  if (options.requireVerifiedActors === true && actorProviders.length === 0) {
    throw new ServerConfigError("`requireVerifiedActors` needs `actorTokens`: with no provider configured no delegated call could ever be made.");
  }

  const platform = resolvePlatform(options.platform, actorProviders);

  return Object.freeze({
    storage: options.storage,
    credentials: options.credentials,
    defaultProvider: provider,
    limits: Object.freeze(limits),
    engine: options.engine,
    actorProviders,
    machineProviders,
    requireVerifiedActors: options.requireVerifiedActors === true,
    invitations: options.invitations,
    policies: options.policies,
    sharedRateLimit: options.sharedRateLimit === true,
    platform,
    webhooks: resolveWebhooks(options.webhooks, options.storage),
    readOnly: options.readOnly === true,
    trustedProxyHops: hops,
    logger: options.logger ?? createJsonLogger(),
    now: options.now ?? (() => new Date()),
  });
}

/** Whether `host` only listens on this machine. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.toLowerCase() === "localhost" || bare === "::1") return true;
  // A real IPv4 address (isIP rejects `127.999.0.1` and short forms such as `127.1`) in 127.0.0.0/8.
  return isIP(bare) === 4 && bare.startsWith("127.");
}

function resolvePlatform(input: PlatformConfig | undefined, actorProviders: readonly ResolvedProvider[]): ResolvedPlatform | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || !input.storage?.platformRoles || !input.storage.platformMembers) throw new ServerConfigError("`platform.storage` is required.");
  const known = new Set(["storage", "providers", "stepUp", "supportGrantablePermissions", "engine"]);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new ServerConfigError(`platform: unknown option "${key}".`);
  const labels = new Set(actorProviders.map((provider) => provider.provider));
  if (!Array.isArray(input.providers) || input.providers.length === 0 || input.providers.some((label) => typeof label !== "string" || !labels.has(label))) {
    throw new ServerConfigError("`platform.providers` must list the `provider` labels of `actorTokens` whose tokens may administer the platform (at least one, and each one configured).");
  }
  const step = input.stepUp ?? {};
  for (const key of Object.keys(step)) if (!["maxAgeSeconds", "requireMfa", "minAssuranceLevel"].includes(key)) throw new ServerConfigError(`platform.stepUp: unknown option "${key}".`);
  const maxAgeSeconds = step.maxAgeSeconds ?? 300;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 3600) throw new ServerConfigError("`platform.stepUp.maxAgeSeconds` must be an integer from 1 to 3600.");
  if (step.requireMfa !== undefined && typeof step.requireMfa !== "boolean") throw new ServerConfigError("`platform.stepUp.requireMfa` must be true or false.");
  if (step.minAssuranceLevel !== undefined && (!Number.isInteger(step.minAssuranceLevel) || step.minAssuranceLevel < 0 || step.minAssuranceLevel > 100)) {
    throw new ServerConfigError("`platform.stepUp.minAssuranceLevel` must be an integer from 0 to 100.");
  }
  if (step.minAssuranceLevel !== undefined && step.minAssuranceLevel > 0 && !actorProviders.some((provider) => input.providers.includes(provider.provider) && provider.acrLevels !== undefined)) {
    throw new ServerConfigError("`platform.stepUp.minAssuranceLevel` needs `acrLevels` on a platform provider, or no sign-in could ever reach it.");
  }
  if (!Array.isArray(input.supportGrantablePermissions) || input.supportGrantablePermissions.some((key) => typeof key !== "string")) {
    // No default: "any registered permission" is close to full access to every organization for 30 days. An empty list means none.
    throw new ServerConfigError("`platform.supportGrantablePermissions` is required: the organization permission keys support access may open (an empty list: none).");
  }
  return Object.freeze({
    storage: input.storage,
    providers: new Set(input.providers),
    stepUp: Object.freeze({ maxAgeSeconds, requireMfa: step.requireMfa !== false, minAssuranceLevel: step.minAssuranceLevel === 0 ? undefined : step.minAssuranceLevel }),
    supportGrantablePermissions: input.supportGrantablePermissions,
    engine: input.engine,
  });
}

function resolveWebhooks(input: WebhooksConfig | undefined, storage: UnioraStorage): WebhooksConfig | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || !input.storage?.endpoints || !input.storage.deliveries) throw new ServerConfigError("`webhooks.storage` is required.");
  const known = new Set(["storage", "outbox", "urlPolicy", "run", "concurrency", "timeoutMs", "maxAttempts", "disableAfterFailures", "disableAfterMinutes", "pollIntervalMs", "retainDeliveredDays"]);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new ServerConfigError(`webhooks: unknown option "${key}".`);
  if (!input.outbox && !storage.outbox) throw new ServerConfigError("`webhooks` needs an outbox: pass `webhooks.outbox`, or use an organization storage that has one.");
  if (input.urlPolicy?.allowInsecureHttp === true && input.urlPolicy.allowPrivateNetworks === true && process.env.NODE_ENV === "production") {
    throw new ServerConfigError("`webhooks.urlPolicy` allows plain http and private networks together in production: that lets a registered endpoint reach your internal services.");
  }
  return Object.freeze({ ...input, outbox: input.outbox ?? storage.outbox });
}
