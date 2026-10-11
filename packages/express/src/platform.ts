import { platformErrorToHttp, runPlatformCommand } from "@uniora/core";
import type { Identity, PlatformCommand, PlatformEngine, PlatformService } from "@uniora/core";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
type NextLike = (err?: unknown) => void;
type Awaitable<T> = T | Promise<T>;

export interface PlatformCommandOptions<Req> {
  /** Which platform command this route is (`"addMember"`, `"suspendMember"`, ...). Fixed per route: the client never picks it. */
  command: PlatformCommand;
  /**
   * The signed-in PLATFORM administrator, from the session of your admin panel, never from the request body. Return
   * `null`/`undefined` when nobody is signed in: the route answers 401. The service still checks what that person may do.
   */
  resolve: (req: Req) => Awaitable<{ actor: Identity } | null | undefined>;
  /** The untrusted input. Default: `req.body` with `req.params` on top. Unknown fields are rejected by the command. */
  params?: (req: Req) => unknown;
}

/**
 * One route for one platform command, over a `PlatformService`:
 *
 * ```ts
 * adminApp.post("/admin/members", platformCommand(platform, { command: "addMember", resolve }));
 * adminApp.post("/admin/organizations/:organizationId/status", platformCommand(platform, { command: "setOrganizationStatus", resolve }));
 * ```
 *
 * Mount it on your admin app, behind your own platform authentication, apart from the routes that serve organizations.
 * Answers `200` with the result, `401` when unauthenticated, `428` when a step-up is needed and `platformErrorToHttp` for the
 * rest (403 never says why); anything unexpected goes to `next(err)`. Hand this the SERVICE, never the repositories.
 */
export function platformCommand<Req = unknown>(service: PlatformService, options: PlatformCommandOptions<Req>) {
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
      res.status(200).json(await runPlatformCommand(service, options.command, { actor: caller.actor }, params));
    } catch (error) {
      const mapped = platformErrorToHttp(error);
      if (mapped) res.status(mapped.status).json(mapped.body);
      else next(error);
    }
  };
}

export interface RequirePlatformPermissionOptions<Req> {
  /** The platform permission the route needs (`platform.billing.refund`, ...). */
  permission: string;
  /** The signed-in platform administrator, or `null` when nobody is signed in (401). */
  resolve: (req: Req) => Awaitable<{ actor: Identity } | null | undefined>;
}

/**
 * Middleware for YOUR OWN admin routes: lets the request through only when the signed-in person holds the platform permission
 * (401 when unauthenticated, 403 otherwise). Fail-closed: an error while checking is a 403, never an allow.
 */
export function requirePlatformPermission<Req = unknown>(engine: PlatformEngine, options: RequirePlatformPermissionOptions<Req>) {
  return async (req: Req, res: ResponseLike, next: NextLike): Promise<void> => {
    let caller: { actor: Identity } | null | undefined;
    try {
      caller = await options.resolve(req);
    } catch (error) {
      next(error);
      return;
    }
    if (!caller) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const allowed = await engine.can({ identity: caller.actor, permission: options.permission }).catch(() => false);
    if (!allowed) {
      res.status(403).json({ error: "forbidden", message: "You are not allowed to do that." });
      return;
    }
    next();
  };
}
