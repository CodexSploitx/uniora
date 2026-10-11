import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import { isIPv6 } from "node:net";
import type { AddressInfo } from "node:net";
import { authenticateApiKey, clientMayAccessOrganization, createAuthorizationEngine } from "@uniora/core";
import type { ApiPrincipal, Identity } from "@uniora/core";
import { ServerConfigError, isLoopbackHost, resolveConfig } from "./config.js";
import type { ResolvedConfig, UnioraServerOptions } from "./config.js";
import { ApiError, errors, problemOf, toApiError } from "./errors.js";
import { assertJsonContentType, hasBody, parseJsonBody, queryToObject, readBody, send } from "./http.js";
import { ActorTokenError, createActorTokenVerifier } from "./actor-token.js";
import { createMachineTokenAuthenticator, looksLikeJwt } from "./machine-token.js";
import type { VerifiedActor } from "./actor-token.js";
import { createApplicationContext, createDelegatedContext, createPlatformContext } from "./delegation.js";
import { actorFromHeaders, completeIdentity } from "./identity.js";
import { ConcurrencyGate, FailureThrottle, RateLimiter } from "./limits.js";
import type { RateLimitDecision } from "./limits.js";
import { SharedRateLimiter } from "./shared-limit.js";
import { createWebhookDispatcher } from "./webhooks/dispatcher.js";
import type { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { matchRoute } from "./route.js";
import type { ApplicationContext, DelegatedContext, PlatformContext, Route, RouteContext } from "./route.js";
import { allRoutes } from "./routes/index.js";
import { ResponseShapeError, parseInput, project, s } from "./schema.js";
import type { Issue } from "./schema.js";

export interface ListenOptions {
  /** Default `127.0.0.1`. Anything that is not a loopback address needs `tls` or `behindTlsProxy`. */
  host?: string;
  /** Default `8787`. `0` picks a free port. */
  port?: number;
  /** Terminate TLS in this process. */
  tls?: HttpsServerOptions;
  /**
   * TLS ends at a reverse proxy in front of this process. Requires `trustedProxyHops >= 1`, and every request except the health
   * checks must carry `X-Forwarded-Proto: https` (set by your proxy), or it is refused: an API key must never travel in the clear.
   */
  behindTlsProxy?: boolean;
}

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Stops accepting connections, lets requests in flight finish (up to `graceMs`, default 10 s) and closes the rest. */
  close(graceMs?: number): Promise<void>;
}

export interface UnioraServer {
  /** A Node request listener: pass it to `http.createServer`, or mount it in Express. Prefer `listen`, which also applies the boot checks and the slow-client timeouts. */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  listen(options?: ListenOptions): Promise<RunningServer>;
  /** The routes, for documentation and tests. */
  readonly routes: readonly Route[];
  /** The webhook dispatcher when `webhooks` is configured. `listen()` starts and stops it; with `handler` alone, start it yourself. */
  readonly webhooks: WebhookDispatcher | undefined;
}

const EMPTY_OBJECT = s.object({});
const MAX_URL_LENGTH = 2048;
const READY_PROBE_ID = "uniora_ready_probe";
const READY_DEADLINE_MS = 2_000;
/** A readiness answer is shared by every probe for this long, so an unauthenticated flood costs the database one probe a second, not one per request. */
const READY_CACHE_MS = 1_000;
/** A target that two parsers could read differently: doubled or backslash slashes, dot segments (also percent-encoded), a fragment. */
const AMBIGUOUS_TARGET = /\/\/|\\|#|%2e|%5c|(?:^|\/)\.\.?(?:\/|$)/i;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
// Versions start at 1: "0" can never match, and the core refuses it.
const IF_MATCH = /^(?:W\/)?"([1-9]\d{0,14})"$/;

/** Every value of a header as the client wrote it: Node folds repeats into one string, which would hide a duplicated header. */
function headerValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]!.toLowerCase() === name) values.push(req.rawHeaders[index + 1]!);
  }
  return values;
}

const requestIdOf = (): string => `req_${randomBytes(12).toString("base64url")}`;

/**
 * The address a failure is counted against. An IPv4-mapped IPv6 address is the IPv4 one, and an IPv6 address is counted by its /64,
 * the smallest block a network is handed: a client that owns one can use billions of addresses inside it for free.
 */
export function throttleKey(address: string): string {
  const bare = address.startsWith("::ffff:") && address.includes(".") ? address.slice(7) : address;
  if (!isIPv6(bare)) return bare;
  const [head = "", tail] = bare.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function sourceOf(req: IncomingMessage, hops: number): string {
  const socket = req.socket.remoteAddress ?? "unknown";
  if (hops === 0) return socket;
  const header = req.headers["x-forwarded-for"];
  const list = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((part) => part.trim()).filter((part) => part !== "");
  return (list[list.length - hops] ?? socket).slice(0, 64);
}

/** `x-forwarded-proto` as the nearest proxy wrote it: the last value of a list, any case. */
function forwardedProto(req: IncomingMessage): string {
  const header = req.headers["x-forwarded-proto"];
  const text = Array.isArray(header) ? header.join(",") : (header ?? "");
  return (text.split(",").pop() ?? "").trim().toLowerCase();
}

const decodeSegment = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw errors.invalidRequest([{ path: "path", code: "pattern" }]);
  }
};

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(errors.timeout()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function createUnioraServer(options: UnioraServerOptions): UnioraServer {
  const config: ResolvedConfig = resolveConfig(options);
  const engine = createAuthorizationEngine(config.storage, config.engine);
  const routes = allRoutes();
  const limits = config.limits;
  // A logger that throws must never take a request, or the process, down with it.
  const log: typeof config.logger = (entry) => {
    try {
      config.logger(entry);
    } catch {
      /* the operator's sink is down: nothing else to do */
    }
  };

  const localRate = new RateLimiter({ perSecond: limits.ratePerSecond, burst: limits.rateBurst });
  // Several instances share one budget per key when the storage keeps it (`sharedRateLimit`); each falls back to its own limit if the storage fails.
  const rate: { take(key: string): RateLimitDecision | Promise<RateLimitDecision> } =
    config.sharedRateLimit && config.credentials.rateLimits
      ? new SharedRateLimiter({ store: config.credentials.rateLimits, perSecond: limits.ratePerSecond, burst: limits.rateBurst, fallback: localRate, onError: (error) => log({ level: "error", msg: "shared rate limit unavailable, limiting per process", error }) })
      : localRate;
  const concurrency = new ConcurrencyGate({ perKey: limits.maxConcurrencyPerKey, global: Number.POSITIVE_INFINITY });
  const verifier = config.actorProviders.length > 0 ? createActorTokenVerifier(config.actorProviders, { now: config.now, onWarning: (message, detail) => log({ level: "warn", msg: message, ...detail }) }) : undefined;
  const webhookDispatcher = config.webhooks
    ? createWebhookDispatcher({
        webhooks: config.webhooks.storage,
        outbox: config.webhooks.outbox!,
        logger: log,
        now: config.now,
        ...(config.webhooks.urlPolicy ? { urlPolicy: config.webhooks.urlPolicy } : {}),
        ...(config.webhooks.concurrency !== undefined ? { concurrency: config.webhooks.concurrency } : {}),
        ...(config.webhooks.timeoutMs !== undefined ? { timeoutMs: config.webhooks.timeoutMs } : {}),
        ...(config.webhooks.maxAttempts !== undefined ? { maxAttempts: config.webhooks.maxAttempts } : {}),
        ...(config.webhooks.disableAfterFailures !== undefined ? { disableAfterFailures: config.webhooks.disableAfterFailures } : {}),
        ...(config.webhooks.disableAfterMinutes !== undefined ? { disableAfterMinutes: config.webhooks.disableAfterMinutes } : {}),
        ...(config.webhooks.pollIntervalMs !== undefined ? { pollIntervalMs: config.webhooks.pollIntervalMs } : {}),
        ...(config.webhooks.retainDeliveredDays !== undefined ? { retainDeliveredDays: config.webhooks.retainDeliveredDays } : {}),
      })
    : undefined;
  const machines = config.machineProviders.providers.length > 0 ? createMachineTokenAuthenticator(config.machineProviders, config.credentials, { now: config.now, onWarning: (message, detail) => log({ level: "warn", msg: message, ...detail }) }) : undefined;
  const failures = new FailureThrottle({ maxFailures: limits.authFailuresPerMinute, windowMs: 60_000 });
  let inFlight = 0;
  let closing = false;

  // One probe at a time, its answer shared for a second: `/readyz` needs no credentials, so it must not scale the database load with the number of callers.
  let readyAt = 0;
  let readyAnswer = false;
  let readyProbe: Promise<boolean> | undefined;
  function ready(): Promise<boolean> {
    if (readyProbe) return readyProbe;
    if (Date.now() - readyAt < READY_CACHE_MS) return Promise.resolve(readyAnswer);
    const work = Promise.all([config.storage.organizations.findById(READY_PROBE_ID), config.credentials.apiClients.findById(READY_PROBE_ID)]);
    work.catch(() => undefined); // a probe that outlived its deadline must not become an unhandled rejection
    readyProbe = withDeadline(work, READY_DEADLINE_MS).then(
      () => true,
      (error: unknown) => {
        log({ level: "error", msg: "readiness check failed", error });
        return false;
      },
    ).then((answer) => {
      readyAnswer = answer;
      readyAt = Date.now();
      readyProbe = undefined;
      return answer;
    });
    return readyProbe;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, requireHttps: boolean): Promise<void> {
    const requestId = requestIdOf();
    const started = Date.now();
    const method = req.method ?? "GET";
    const extra: Record<string, string> = {};
    let route: Route | undefined;
    let principal: ApiPrincipal | undefined;
    let status = 500;
    let bodyRead = false;
    let releaseSlot: (() => void) | undefined;
    let handlerRunning: Promise<unknown> | undefined;
    let timedOut = false;
    let delegatedContext: DelegatedContext | undefined;
    let applicationContext: ApplicationContext | undefined;
    let platformContext: PlatformContext | undefined;
    const source = sourceOf(req, config.trustedProxyHops);

    const respond = (body: unknown, code: number, headers?: Record<string, string>, contentType?: string) => {
      status = code;
      send(res, body, {
        status: code,
        requestId,
        headers: { ...extra, ...headers },
        ...(contentType ? { contentType } : {}),
        close: (hasBody(req) && !bodyRead) || closing,
      });
    };

    let counted = false;
    try {
      const target = req.url ?? "";
      if (!target.startsWith("/") || target.length > MAX_URL_LENGTH) throw errors.notFound();
      // Routed on the path exactly as the client wrote it. Normalizing it (`//x/v1/..`, `/v1/./check`, `%2e%2e`) would let a front proxy that
      // enforces rules on the raw path and this server disagree about which route a request is.
      const queryAt = target.indexOf("?");
      const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
      const search = queryAt < 0 ? "" : target.slice(queryAt + 1);
      if (AMBIGUOUS_TARGET.test(pathname) || search.includes("#")) throw errors.notFound();

      // Liveness and readiness: no credentials, and no detail about what is wrong.
      if ((method === "GET" || method === "HEAD") && (pathname === "/healthz" || pathname === "/readyz")) {
        if (pathname === "/healthz") return respond({ status: "ok" }, 200);
        return (await ready()) ? respond({ status: "ready" }, 200) : respond({ status: "unavailable" }, 503);
      }
      if (!pathname.startsWith("/v1/")) throw errors.notFound();

      inFlight += 1;
      counted = true;
      if (inFlight > limits.maxInFlight) throw errors.overloaded();
      if (requireHttps && forwardedProto(req) !== "https") throw new ApiError(403, "tls_required");

      // 1. Who is calling. Everything below /v1 needs a valid key, even to learn that a route does not exist.
      const blockedFor = failures.blockedFor(throttleKey(source));
      if (blockedFor > 0) throw errors.rateLimited(blockedFor);
      try {
        const bearer = typeof req.headers.authorization === "string" ? /^Bearer ([^ ]+)$/i.exec(req.headers.authorization)?.[1] : undefined;
        if (machines && bearer !== undefined && looksLikeJwt(bearer)) {
          // The deployment's own OAuth server proved who the machine is; any reason it did not is the same 401 as a bad key.
          principal = (await machines.authenticate(bearer).catch((error: unknown) => {
            if (!(error instanceof ActorTokenError)) throw error;
            if (error.kind === "unavailable") throw error;
            log({ level: "warn", msg: "machine token refused", requestId, kind: error.kind, reason: error.reason });
            return null;
          })) ?? undefined;
        } else {
          principal = (await authenticateApiKey(config.credentials, req.headers.authorization, { now: config.now() })) ?? undefined;
        }
      } catch (error) {
        log({ level: "error", msg: "credential storage failed", requestId, error });
        throw new ApiError(503, "unavailable", { headers: { "Retry-After": "5" } });
      }
      if (!principal) {
        failures.recordFailure(throttleKey(source));
        throw errors.unauthenticated();
      }

      // 2. How much it may ask.
      const decision = await rate.take(principal.key.id);
      extra["RateLimit-Limit"] = String(decision.limit);
      extra["RateLimit-Remaining"] = String(decision.remaining);
      if (!decision.allowed) throw errors.rateLimited(decision.retryAfterSeconds);
      const slot = concurrency.acquire(principal.key.id);
      if ("rejected" in slot) throw errors.rateLimited(1);
      releaseSlot = slot.release;

      // 3. What it asks for.
      const matched = matchRoute(routes, method, pathname);
      if (matched.kind === "none") throw errors.notFound();
      if (matched.kind === "method") throw errors.methodNotAllowed(matched.allow);
      route = matched.route;

      // 4. Whether it may. The answer never says which part failed.
      if (!principal.client.scopes.includes(route.scope)) {
        log({ level: "warn", msg: "scope refused", requestId, route: route.id, clientId: principal.client.id, scope: route.scope });
        throw errors.forbidden();
      }
      if (route.write && config.readOnly) throw errors.readOnly();

      if (route.allOrganizations && principal.client.organizations !== "*") {
        log({ level: "warn", msg: "organization list refused", requestId, route: route.id, clientId: principal.client.id });
        throw errors.forbidden();
      }

      // Who the call speaks for. A delegated call changes things as an end user: either the server verified the user's own token
      // (`actor:verified`, or `actor:assert`), or the caller asserted who they are in headers (`actor:assert`: a key that holds it can
      // name anybody, which is why `requireVerifiedActors` can switch it off). A route that only profits from knowing the person may
      // take the token too; no other route takes an actor at all.
      let actor: Identity | undefined;
      let verifiedActor: VerifiedActor | undefined;
      let actorMode: "asserted" | "verified" | undefined;
      const tokenValues = headerValues(req, "uniora-actor-token");
      const subjectValues = headerValues(req, "uniora-actor-subject");
      const providerValues = headerValues(req, "uniora-actor-provider");
      const takesActor = route.delegated || route.actorToken || route.platform;
      if (route.platform && !config.platform) throw errors.notImplemented("platform_not_configured");
      if (!route.delegated && (subjectValues.length > 0 || providerValues.length > 0)) throw errors.invalidRequest([{ path: subjectValues.length > 0 ? "Uniora-Actor-Subject" : "Uniora-Actor-Provider", code: "unknown_field" }]);
      if (tokenValues.length > 0) {
        if (!takesActor) throw errors.invalidRequest([{ path: "Uniora-Actor-Token", code: "unknown_field" }]);
        if (tokenValues.length > 1 || subjectValues.length > 0 || providerValues.length > 0) throw errors.invalidRequest([{ path: "Uniora-Actor-Token", code: "too_many" }]);
        if (!verifier) throw errors.notImplemented("actor_token_unsupported");
        if (route.delegated && !principal.client.scopes.includes("actor:verified") && !principal.client.scopes.includes("actor:assert")) {
          log({ level: "warn", msg: "scope refused", requestId, route: route.id, clientId: principal.client.id, scope: "actor:verified" });
          throw errors.forbidden();
        }
        try {
          verifiedActor = await verifier.verify(tokenValues[0]!);
        } catch (error) {
          if (!(error instanceof ActorTokenError)) throw error;
          // Always the same answer to the caller; the reason is for the operator (never the token).
          log({ level: "warn", msg: "actor token refused", requestId, clientId: principal.client.id, kind: error.kind, reason: error.reason });
          if (error.kind === "unavailable") throw new ApiError(503, "actor_token_unavailable", { headers: { "Retry-After": "5" } });
          throw new ApiError(401, "actor_token_invalid", { headers: { "WWW-Authenticate": 'Bearer realm="uniora", error="invalid_token"' } });
        }
        // Platform power is the operator's own: a token from a provider that is not a platform provider (a customer's, say) is refused.
        if (route.platform && !config.platform!.providers.has(verifiedActor.identity.provider)) {
          log({ level: "warn", msg: "platform token from a provider that may not administer the platform", requestId, clientId: principal.client.id, provider: verifiedActor.identity.provider });
          throw errors.forbidden();
        }
        actor = verifiedActor.identity;
        actorMode = "verified";
      } else if (route.platform) {
        // Never the key alone and never an asserted operator.
        throw new ApiError(403, "actor_token_required");
      } else if (route.delegated) {
        if (config.requireVerifiedActors) throw new ApiError(403, "actor_token_required");
        if (!principal.client.scopes.includes("actor:assert")) {
          log({ level: "warn", msg: "scope refused", requestId, route: route.id, clientId: principal.client.id, scope: "actor:assert" });
          throw errors.forbidden();
        }
        actor = actorFromHeaders({ subject: subjectValues, provider: providerValues }, config.defaultProvider);
        actorMode = "asserted";
      }
      const keyHeader = req.headers["idempotency-key"];
      if (keyHeader !== undefined && !route.idempotent) throw errors.invalidRequest([{ path: "Idempotency-Key", code: "unknown_field" }]);
      if (req.headers["if-match"] !== undefined && !route.ifMatch) throw errors.invalidRequest([{ path: "If-Match", code: "unknown_field" }]);
      if (keyHeader !== undefined && (typeof keyHeader !== "string" || !IDEMPOTENCY_KEY.test(keyHeader))) throw errors.invalidRequest([{ path: "Idempotency-Key", code: "pattern" }]);
      const ifMatchHeader = req.headers["if-match"];
      let ifMatch: number | undefined;
      if (ifMatchHeader !== undefined) {
        const parsed = typeof ifMatchHeader === "string" ? IF_MATCH.exec(ifMatchHeader.trim()) : null;
        if (!parsed) throw errors.invalidRequest([{ path: "If-Match", code: "pattern" }]);
        ifMatch = Number(parsed[1]);
      }

      // 5. Whether what it sent is acceptable: strict, bounded, and fully checked before any handler runs.
      const issues: Issue[] = [];
      const rawParams: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(matched.rawParams)) rawParams[name] = decodeSegment(value);
      const params = route.params ? parseInput(route.params, rawParams) : undefined;
      if (params && !params.ok) issues.push(...params.issues);

      const query = queryToObject(route.query, new URLSearchParams(search));
      issues.push(...query.issues);
      const parsedQuery = parseInput(route.query ?? EMPTY_OBJECT, query.value);
      if (!parsedQuery.ok) issues.push(...parsedQuery.issues);

      let parsedBody: { ok: true; value: unknown } | { ok: false; issues: readonly Issue[] } | undefined;
      if (route.body) {
        assertJsonContentType(req);
        const raw = await readBody(req, limits.maxBodyBytes);
        bodyRead = true;
        parsedBody = parseInput(route.body, parseJsonBody(raw));
        if (!parsedBody.ok) issues.push(...parsedBody.issues);
      } else if (hasBody(req)) {
        throw errors.unexpectedBody();
      }
      if (issues.length > 0) throw errors.invalidRequest(issues);

      const input = {
        params: params && params.ok ? params.value : undefined,
        query: route.query ? (parsedQuery as { value: unknown }).value : undefined,
        body: parsedBody && parsedBody.ok ? parsedBody.value : undefined,
      };
      const extraIssues = route.refine?.(input as never) ?? [];
      if (extraIssues.length > 0) throw errors.invalidRequest(extraIssues);

      // 6. Whether it may touch THIS organization. An organization outside the key's list answers exactly like one that does not exist.
      const organizationId = route.organization?.(input as never);
      if (organizationId !== undefined && !clientMayAccessOrganization(principal.client, organizationId)) throw errors.notFound("organization_not_found");

      // 7. The work, under a deadline. The slot is held until the work really ends, even after the answer was a timeout.
      const context: RouteContext = {
        requestId,
        principal,
        config,
        engine,
        now: config.now,
        resolveIdentity: (identity, path) => completeIdentity(identity, config.defaultProvider, path),
        verifiedActor,
        application: () => {
          if (!principal) throw new Error("No principal.");
          applicationContext ??= delegatedContext ?? createApplicationContext(config, principal, requestId, actorMode);
          return applicationContext;
        },
        platform: () => {
          if (!route!.platform || !verifiedActor || !principal) throw new Error(`Route ${route!.id} asked for a platform context but is not marked platform.`);
          platformContext ??= createPlatformContext(config, principal, requestId, verifiedActor);
          return platformContext;
        },
        delegated: () => {
          if (!actor || !principal) throw new Error(`Route ${route!.id} asked for a delegated context but is not marked delegated.`);
          delegatedContext ??= createDelegatedContext(config, principal, requestId, actor, actorMode!);
          return delegatedContext;
        },
        ifMatch,
        idempotencyKey: keyHeader as string | undefined,
        setHeader: (name, value) => {
          if (name === "ETag" && !route!.etag) throw new Error(`Route ${route!.id} sets an ETag but is not declared with etag: true.`);
          if (name === "ETag" || name === "Location") extra[name] = value;
        },
      };
      handlerRunning = route.handler(context, input as never);
      let result: unknown;
      try {
        result = await withDeadline(handlerRunning, limits.requestTimeoutMs);
      } catch (error) {
        if (error instanceof ApiError && error.code === "timeout") timedOut = true;
        throw error;
      }
      let payload: unknown;
      try {
        payload = project(route.response, result);
      } catch (error) {
        if (error instanceof ResponseShapeError) throw errors.internal(error);
        throw error;
      }
      return route.status === 204 ? respond(undefined, 204) : respond(payload, route.status);
    } catch (caught) {
      const error = toApiError(caught);
      const level = error.status >= 500 ? "error" : "info";
      if (error.status >= 500 || error.cause !== undefined) log({ level, msg: "request failed", requestId, route: route?.id, code: error.code, error: error.cause ?? error });
      respond(problemOf(error, requestId), error.status, { ...error.headers }, "application/problem+json; charset=utf-8");
    } finally {
      if (counted) inFlight -= 1;
      const release = releaseSlot;
      if (release) {
        if (handlerRunning) {
          // The caller already got its 503 `timeout`; a write that fails afterwards must still leave a trace.
          void handlerRunning.then(release, (error: unknown) => {
            if (timedOut) log({ level: "error", msg: "request failed after its deadline", requestId, route: route?.id, error });
            release();
          });
        } else release();
      }
      log({
        level: "info",
        msg: "request",
        requestId,
        method,
        route: route?.id,
        status,
        durationMs: Date.now() - started,
        clientId: principal?.client.id,
        keyId: principal?.key.id,
        source,
      });
    }
  }

  const run = (requireHttps: boolean) => (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res, requireHttps).catch((error: unknown) => {
      // `handle` answers its own errors; reaching here means the answer itself failed. Never let it crash the process.
      log({ level: "error", msg: "unhandled failure", error });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  };
  const handler = run(false);

  async function listen(listenOptions: ListenOptions = {}): Promise<RunningServer> {
    const host = listenOptions.host ?? "127.0.0.1";
    if (!isLoopbackHost(host) && !listenOptions.tls && !listenOptions.behindTlsProxy) {
      throw new ServerConfigError(
        `Refusing to listen on "${host}" without TLS: pass \`tls\`, or \`behindTlsProxy: true\` (with \`trustedProxyHops\`) when a reverse proxy ends TLS. API keys must never travel in the clear.`,
      );
    }
    if (listenOptions.behindTlsProxy && config.trustedProxyHops < 1) {
      throw new ServerConfigError("`behindTlsProxy` needs `trustedProxyHops` of at least 1, so the caller's address (and the failed-authentication throttle) is the real one.");
    }
    if (listenOptions.tls && listenOptions.behindTlsProxy) throw new ServerConfigError("Choose `tls` or `behindTlsProxy`, not both.");

    // Node enforces the header and body timeouts only when it sweeps connections (every 30 s by default): sweep often enough that a slow client lives about as long as configured.
    const connectionsCheckingInterval = Math.min(5_000, Math.max(250, Math.floor(Math.min(limits.headersTimeoutMs, limits.requestBodyTimeoutMs) / 2)));
    const server: Server = listenOptions.tls
      ? createHttpsServer({ ...listenOptions.tls, maxHeaderSize: limits.maxHeaderBytes, connectionsCheckingInterval }, run(false))
      : createHttpServer({ maxHeaderSize: limits.maxHeaderBytes, connectionsCheckingInterval }, run(listenOptions.behindTlsProxy === true));
    server.headersTimeout = limits.headersTimeoutMs;
    server.requestTimeout = limits.requestBodyTimeoutMs;
    server.keepAliveTimeout = limits.keepAliveTimeoutMs;
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      else socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenOptions.port ?? 8787, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Read-only is for a migration or an incident: it must not keep writing deliveries or calling other systems either.
    if (config.webhooks?.run !== false && !config.readOnly) webhookDispatcher?.start();
    const address = server.address() as AddressInfo;
    const shownHost = host.includes(":") ? `[${host}]` : host;
    const scheme = listenOptions.tls ? "https" : "http";
    return {
      host,
      port: address.port,
      url: `${scheme}://${shownHost}:${address.port}`,
      close: (graceMs = 10_000) =>
        new Promise<void>((resolve) => {
          closing = true; // every answer from now on says `Connection: close`, so a keep-alive connection does not hold the shutdown open
          const force = setTimeout(() => server.closeAllConnections(), graceMs);
          const sweep = setInterval(() => server.closeIdleConnections(), 100);
          server.close(() => {
            clearTimeout(force);
            clearInterval(sweep);
            // Requests are done: let the attempts in flight finish, then stop sending.
            void (webhookDispatcher?.stop() ?? Promise.resolve()).finally(resolve);
          });
          server.closeIdleConnections();
        }),
    };
  }

  return { handler, listen, routes, webhooks: webhookDispatcher };
}
