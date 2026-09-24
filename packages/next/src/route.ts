import type { AccessCheckInput, AuthorizationEngine } from "@uniora/core";

export interface AuthorizeRouteOptions {
  /** HTTP status for the denial response. Defaults to 403. */
  status?: number;
  /** JSON body for the denial response. Defaults to `{ error: "forbidden" }`. */
  body?: unknown;
}

/**
 * Authorization helper for Next.js Route Handlers, which are plain
 * `Request -> Response` functions (Web Fetch API, not a `next` import) —
 * this is why it returns a `Response | null` instead of throwing like
 * `assertAccess`: a Route Handler is expected to explicitly `return` its
 * response, not rely on an uncaught exception turning into one.
 *
 * ```ts
 * export async function DELETE(request: Request) {
 *   const denied = await authorizeRoute(engine, {
 *     identity, organizationId, permission: "vehicles.delete",
 *   });
 *   if (denied) return denied;
 *   // ... perform the operation
 * }
 * ```
 *
 * Returns `null` when access is granted (caller continues), or a ready-to-return
 * `Response` when it isn't. Delegates to `engine.access.check()` unchanged.
 */
export async function authorizeRoute(
  engine: AuthorizationEngine,
  input: AccessCheckInput,
  options: AuthorizeRouteOptions = {},
): Promise<Response | null> {
  const allowed = await engine.access.check(input);
  if (allowed) return null;

  const { status = 403, body = { error: "forbidden" } } = options;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
