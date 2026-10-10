import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { AddressInfo } from "node:net";
import { authenticateApiKey, clientMayAccessOrganization, createAuthorizationEngine } from "@uniora/core";
import type { ApiPrincipal, Identity } from "@uniora/core";
import { ServerConfigError, isLoopbackHost, resolveConfig } from "./config.js";
import type { ResolvedConfig, UnioraServerOptions } from "./config.js";
import { ApiError, errors, problemOf, toApiError } from "./errors.js";
import { assertJsonContentType, hasBody, parseJsonBody, queryToObject, readBody, send } from "./http.js";
import { createDelegatedContext } from "./delegation.js";
import { actorFromHeaders, completeIdentity } from "./identity.js";
import { ConcurrencyGate, FailureThrottle, RateLimiter } from "./limits.js";
import { matchRoute } from "./route.js";
import type { DelegatedContext, Route, RouteContext } from "./route.js";
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
}

const EMPTY_OBJECT = s.object({});
const MAX_URL_LENGTH = 2048;
const READY_PROBE_ID = "uniora_ready_probe";
const READY_DEADLINE_MS = 2_000;

const IF_MATCH = /^(?:W\/)?"(\d{1,15})"$/;

/** Every value of a header as the client wrote it: Node folds repeats into one string, which would hide a duplicated header. */
function headerValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]!.toLowerCase() === name) values.push(req.rawHeaders[index + 1]!);
  }
  return values;
}

const requestIdOf = (): string => `req_${randomBytes(12).toString("base64url")}`;

function sourceOf(req: IncomingMessage, hops: number): string {
  const socket = req.socket.remoteAddress ?? "unknown";
  if (hops === 0) return socket;
  const header = req.headers["x-forwarded-for"];
  const list = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((part) => part.trim()).filter((part) => part !== "");
  return (list[list.length - hops] ?? socket).slice(0, 64);
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
  const log = config.logger;

  const rate = new RateLimiter({ perSecond: limits.ratePerSecond, burst: limits.rateBurst });
  const concurrency = new ConcurrencyGate({ perKey: limits.maxConcurrencyPerKey, global: Number.POSITIVE_INFINITY });
  const failures = new FailureThrottle({ maxFailures: limits.authFailuresPerMinute, windowMs: 60_000 });
  let inFlight = 0;
  let behindTlsProxy = false;

  async function ready(): Promise<boolean> {
    try {
      await withDeadline(
        Promise.all([config.storage.organizations.findById(READY_PROBE_ID), config.credentials.apiClients.findById(READY_PROBE_ID)]),
        READY_DEADLINE_MS,
      );
      return true;
    } catch (error) {
      log({ level: "error", msg: "readiness check failed", error });
      return false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    let delegatedContext: DelegatedContext | undefined;
    const source = sourceOf(req, config.trustedProxyHops);

    const respond = (body: unknown, code: number, headers?: Record<string, string>, contentType?: string) => {
      status = code;
      send(res, body, {
        status: code,
        requestId,
        headers: { ...extra, ...headers },
        ...(contentType ? { contentType } : {}),
        close: hasBody(req) && !bodyRead,
      });
    };

    inFlight += 1;
    try {
      const target = req.url ?? "";
      if (!target.startsWith("/") || target.length > MAX_URL_LENGTH) throw errors.notFound();
      const url = new URL(target, "http://uniora.invalid");
      const pathname = url.pathname;

      // Liveness and readiness: no credentials, and no detail about what is wrong.
      if (method === "GET" && (pathname === "/healthz" || pathname === "/readyz")) {
        if (pathname === "/healthz") return respond({ status: "ok" }, 200);
        return (await ready()) ? respond({ status: "ready" }, 200) : respond({ status: "unavailable" }, 503);
      }
      if (!pathname.startsWith("/v1/")) throw errors.notFound();

      if (inFlight > limits.maxInFlight) throw errors.overloaded();
      if (behindTlsProxy && req.headers["x-forwarded-proto"] !== "https") throw new ApiError(403, "tls_required");

      // 1. Who is calling. Everything below /v1 needs a valid key, even to learn that a route does not exist.
      const blockedFor = failures.blockedFor(source);
      if (blockedFor > 0) throw errors.rateLimited(blockedFor);
      try {
        principal = (await authenticateApiKey(config.credentials, req.headers.authorization, { now: config.now() })) ?? undefined;
      } catch (error) {
        log({ level: "error", msg: "credential storage failed", requestId, error });
        throw new ApiError(503, "unavailable", { headers: { "Retry-After": "5" } });
      }
      if (!principal) {
        failures.recordFailure(source);
        throw errors.unauthenticated();
      }

      // 2. How much it may ask.
      const decision = rate.take(principal.key.id);
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

      // A delegated call speaks for an end user: it needs the separate `actor:assert` scope, and says who in its own headers.
      let actor: Identity | undefined;
      if (route.delegated) {
        if (!principal.client.scopes.includes("actor:assert")) {
          log({ level: "warn", msg: "scope refused", requestId, route: route.id, clientId: principal.client.id, scope: "actor:assert" });
          throw errors.forbidden();
        }
        if (req.headers["uniora-actor-token"] !== undefined) throw errors.notImplemented("actor_token_unsupported");
        actor = actorFromHeaders({ subject: headerValues(req, "uniora-actor-subject"), provider: headerValues(req, "uniora-actor-provider") }, config.defaultProvider);
      }
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

      const query = queryToObject(route.query, url.searchParams);
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
        delegated: () => {
          if (!actor || !principal) throw new Error(`Route ${route!.id} asked for a delegated context but is not marked delegated.`);
          delegatedContext ??= createDelegatedContext(config, principal, requestId, actor);
          return delegatedContext;
        },
        ifMatch,
        setHeader: (name, value) => {
          if (name === "ETag" || name === "Location") extra[name] = value;
        },
      };
      handlerRunning = route.handler(context, input as never);
      const result = await withDeadline(handlerRunning, limits.requestTimeoutMs);
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
      inFlight -= 1;
      const release = releaseSlot;
      if (release) {
        if (handlerRunning) void handlerRunning.then(release, release);
        else release();
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

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((error: unknown) => {
      // `handle` answers its own errors; reaching here means the answer itself failed. Never let it crash the process.
      log({ level: "error", msg: "unhandled failure", error });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  };

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
    behindTlsProxy = listenOptions.behindTlsProxy === true;

    const server: Server = listenOptions.tls
      ? createHttpsServer({ ...listenOptions.tls, maxHeaderSize: limits.maxHeaderBytes }, handler)
      : createHttpServer({ maxHeaderSize: limits.maxHeaderBytes }, handler);
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
    const address = server.address() as AddressInfo;
    const shownHost = host.includes(":") ? `[${host}]` : host;
    const scheme = listenOptions.tls ? "https" : "http";
    return {
      host,
      port: address.port,
      url: `${scheme}://${shownHost}:${address.port}`,
      close: (graceMs = 10_000) =>
        new Promise<void>((resolve) => {
          const force = setTimeout(() => server.closeAllConnections(), graceMs);
          server.close(() => {
            clearTimeout(force);
            resolve();
          });
          server.closeIdleConnections();
        }),
    };
  }

  return { handler, listen, routes };
}
