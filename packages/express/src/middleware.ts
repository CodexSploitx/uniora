import type { AuthorizationEngine, Identity } from "@uniora/core";

/** Who is calling and in which organization — the two things the engine cannot guess. */
export interface AuthorizationContext {
  identity: Identity;
  organizationId: string;
}

// Structural slices of Express's `Response`/`NextFunction`, so this package needs no
// dependency on `express` (nor on its types) — your app passes its own, already-configured one.
interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
type NextLike = (err?: unknown) => void;

type Awaitable<T> = T | Promise<T>;

export interface MiddlewareOptions<Req> {
  /**
   * Turns the request into an `AuthorizationContext` — typically by reading the session your
   * auth provider's adapter resolved earlier (e.g. `req.identity`) plus the organization from
   * the route (`req.params.orgId`). Return `null`/`undefined` when the caller is not authenticated
   * or no organization applies: the middleware answers 401 without asking the engine.
   * If it throws or rejects, the error goes to `next(err)` — the request is never let through.
   */
  resolve: (req: Req) => Awaitable<AuthorizationContext | null | undefined>;
  /** Custom response for a denied check. Defaults to `403 { "error": "forbidden" }`. */
  onDenied?: (req: Req, res: ResponseLike) => void;
  /** Custom response when `resolve` yields no context. Defaults to `401 { "error": "unauthenticated" }`. */
  onUnauthenticated?: (req: Req, res: ResponseLike) => void;
}

export interface AuthorizeOptions<Req> extends MiddlewareOptions<Req> {
  /** Permission key the caller must hold. A function lets it depend on the request. */
  permission?: string | ((req: Req) => string);
  /** Feature key the organization must have enabled. */
  feature?: string | ((req: Req) => string);
}

/**
 * Express middleware that lets the request continue (`next()`) only when the engine allows it,
 * and otherwise answers 401/403 itself.
 *
 * Fail-closed by construction: `next()` is called in exactly one place — right after the engine
 * answered `true`. Any error (from `resolve`, the engine, or the database behind it) goes to
 * `next(err)`, never to `next()`. Errors are also caught explicitly, so this works on Express 4,
 * which does not forward rejected promises from middleware.
 *
 * ```ts
 * app.delete(
 *   "/orgs/:orgId/vehicles/:id",
 *   requirePermission(engine, "vehicles.delete", {
 *     resolve: (req) => req.identity && { identity: req.identity, organizationId: req.params.orgId },
 *   }),
 *   deleteVehicle,
 * );
 * ```
 *
 * At least one of `permission`/`feature` is required (checked when the middleware is created, not
 * per request). With only `permission` it delegates to `engine.can()`; otherwise to
 * `engine.access.check()` — unchanged either way. Server-side authorization is the real
 * boundary: this is it, so mount it on every route that needs one.
 */
export function authorize<Req = unknown>(
  engine: AuthorizationEngine,
  options: AuthorizeOptions<Req>,
): (req: Req, res: ResponseLike, next: NextLike) => Promise<void> {
  const { permission, feature, resolve, onDenied, onUnauthenticated } = options;
  if (permission === undefined && feature === undefined) {
    throw new TypeError("authorize(): pass at least one of `permission` or `feature`");
  }

  return async (req, res, next) => {
    try {
      const context = await resolve(req);
      if (!context) {
        if (onUnauthenticated) onUnauthenticated(req, res);
        else res.status(401).json({ error: "unauthenticated" });
        return;
      }

      const permissionKey = typeof permission === "function" ? permission(req) : permission;
      const featureKey = typeof feature === "function" ? feature(req) : feature;
      const allowed =
        featureKey === undefined && permissionKey !== undefined
          ? await engine.can({ ...context, permission: permissionKey })
          : await engine.access.check({
              ...context,
              ...(permissionKey !== undefined ? { permission: permissionKey } : {}),
              ...(featureKey !== undefined ? { feature: featureKey } : {}),
            });

      if (allowed !== true) {
        if (onDenied) onDenied(req, res);
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

/** Shorthand for `authorize(engine, { permission, ...options })`. */
export function requirePermission<Req = unknown>(
  engine: AuthorizationEngine,
  permission: string | ((req: Req) => string),
  options: MiddlewareOptions<Req>,
) {
  return authorize(engine, { ...options, permission });
}

/** Shorthand for `authorize(engine, { feature, ...options })` — the organization must have the feature on. */
export function requireFeature<Req = unknown>(
  engine: AuthorizationEngine,
  feature: string | ((req: Req) => string),
  options: MiddlewareOptions<Req>,
) {
  return authorize(engine, { ...options, feature });
}
