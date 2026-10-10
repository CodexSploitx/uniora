import { policyErrorToHttp, runPolicyCommand } from "@uniora/core";
import type { AuthorizationEngine, AuthorizationResult, AuthorizeInput, Identity, PolicyCommand, PolicyService } from "@uniora/core";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
type NextLike = (err?: unknown) => void;
type Awaitable<T> = T | Promise<T>;

export interface PolicyCommandOptions<Req> {
  /** Which policy command this route is (`"createPolicy"`, `"activatePolicy"`, ...). Fixed per route: the client never picks it. */
  command: PolicyCommand;
  /**
   * The signed-in caller and the organization they are working in, from YOUR session or route, never from the request body.
   * Return `null`/`undefined` when nobody is signed in: the route answers 401. The service still checks the caller's rights.
   */
  resolve: (req: Req) => Awaitable<{ actor: Identity; organizationId: string } | null | undefined>;
  /**
   * The untrusted input. Default: `req.body` with `req.params` on top (a `/policies/:policyId` in the path wins over a
   * `policyId` in the body). For `listPolicies` and `listRevisions` pass a function that reads the query string. Unknown fields
   * are rejected by the command.
   */
  params?: (req: Req) => unknown;
}

/**
 * One route for one policy command, over a `PolicyService`:
 *
 * ```ts
 * app.post("/policies", policyCommand(policies, { command: "createPolicy", resolve }));
 * app.post("/policies/:policyId/activate", policyCommand(policies, { command: "activatePolicy", resolve }));
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated and `policyErrorToHttp` for every `PolicyError` (403 never says
 * why); anything unexpected goes to `next(err)`. Hand this the SERVICE, never `storage.policies`: only the service checks what
 * the caller may do.
 */
export function policyCommand<Req = unknown>(service: PolicyService, options: PolicyCommandOptions<Req>) {
  return async (req: Req, res: ResponseLike, next: NextLike): Promise<void> => {
    try {
      const caller = await options.resolve(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const raw = req as { body?: unknown; params?: unknown };
      const params =
        options.params?.(req) ??
        { ...(typeof raw.body === "object" && raw.body !== null ? raw.body : {}), ...(typeof raw.params === "object" && raw.params !== null ? raw.params : {}) };
      const result = await runPolicyCommand(service, options.command, { actor: caller.actor, organizationId: caller.organizationId }, params);
      res.status(200).json(result);
    } catch (error) {
      const mapped = policyErrorToHttp(error);
      if (mapped) res.status(mapped.status).json(mapped.body);
      else next(error);
    }
  };
}

/** What the engine needs for a question about one resource. */
export interface ResourceAuthorizationContext {
  identity: Identity;
  organizationId: string;
  /** The resource the request is about: its type, id, organization, teams and declared attributes. */
  resource?: AuthorizeInput["resource"];
  /** Signals your server verified about the circumstances of the request (`contextual` policies read them as `context.<name>`). Never copy them from the request. */
  context?: AuthorizeInput["context"];
  /** How the person authenticated, from YOUR verified session or token (`sensitive` policies read it as `session.*`). Never copy it from the request. */
  session?: AuthorizeInput["session"];
  /** Evaluate the caller's rights inside this team (see `engine.can`). */
  teamId?: string;
  /** Turn "no policy applies" into a refusal for this route. */
  requireApplicablePolicy?: boolean;
}

export interface AuthorizeResourceOptions<Req> {
  /** Permission key the caller must hold. A function lets it depend on the request. */
  permission: string | ((req: Req) => string);
  /**
   * Turns the request into the question: the caller, the organization and the resource (loaded from YOUR database, never taken
   * from the request body). `null`/`undefined` answers 401 without asking the engine. If it throws, the error goes to `next(err)`.
   */
  resolve: (req: Req) => Awaitable<ResourceAuthorizationContext | null | undefined>;
  /** Custom response for a refusal. It receives the full result for logging; do NOT send `result.policies` to the client. Defaults to `403 { "error": "forbidden" }`. */
  onDenied?: (req: Req, res: ResponseLike, result: AuthorizationResult) => void;
  /** Called with every result (allow, deny and indeterminate) before the response; errors it throws go to `next(err)`. */
  onDecision?: (req: Req, result: AuthorizationResult) => Awaitable<void>;
}

/**
 * Express middleware that lets the request continue only when `engine.authorize()` allows the permission on this resource, i.e. the
 * role-based decision AND every active policy of the organization. Fail-closed like `requirePermission`: `next()` is called in one
 * place, after `result.allowed === true`; `deny` and `indeterminate` both answer 403, and any error goes to `next(err)`.
 *
 * ```ts
 * app.patch("/vehicles/:id", authorizeResource(engine, {
 *   permission: "vehicles.update",
 *   resolve: async (req) => req.identity && { identity: req.identity, organizationId: req.org, resource: await loadVehicle(req.params.id) },
 * }), updateVehicle);
 * ```
 */
export function authorizeResource<Req = unknown>(
  engine: AuthorizationEngine,
  options: AuthorizeResourceOptions<Req>,
): (req: Req, res: ResponseLike, next: NextLike) => Promise<void> {
  const { permission, resolve, onDenied, onDecision } = options;
  if (permission === undefined) throw new TypeError("authorizeResource(): pass a `permission`");

  return async (req, res, next) => {
    try {
      const context = await resolve(req);
      if (!context) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const key = typeof permission === "function" ? permission(req) : permission;
      if (typeof key !== "string" || key.length === 0) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const result = await engine.authorize({ ...context, permission: key });
      if (onDecision) await onDecision(req, result);
      if (result.allowed !== true) {
        if (onDenied) onDenied(req, res, result);
        else res.status(403).json({ error: "forbidden" });
        return;
      }
    } catch (error) {
      next(error);
      return;
    }
    next();
  };
}
