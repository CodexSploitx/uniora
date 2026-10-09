import { policyErrorToHttp, runPolicyCommand } from "@uniora/core";
import type { AuthorizationEngine, AuthorizationResult, AuthorizeInput, Identity, PolicyCommand, PolicyService } from "@uniora/core";
import { AuthorizationDeniedError } from "./guard.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface PolicyCommandRouteInput {
  /** Which policy command this route is. Fixed per route: the client never picks it. */
  command: PolicyCommand;
  /**
   * The signed-in caller and the organization they work in, from your session or route, never from the request body.
   * `null` when nobody is signed in (answers 401). The service still checks the caller's rights in that organization.
   */
  caller: { actor: Identity; organizationId: string } | null | undefined;
  /** The untrusted input: the parsed JSON body (or query) with the route params on top. Unknown fields are rejected. */
  params: unknown;
}

/**
 * Route Handler body for one policy command over a `PolicyService`:
 *
 * ```ts
 * export async function POST(request: Request, { params }: { params: { policyId: string } }) {
 *   return policyCommandRoute(policies, { command: "activatePolicy", caller: await currentCaller(), params: { ...(await request.json()), ...params } });
 * }
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated and `policyErrorToHttp` for every `PolicyError` (403 never says
 * why); unexpected errors are rethrown. Hand this the SERVICE, never `storage.policies`.
 */
export async function policyCommandRoute(service: PolicyService, input: PolicyCommandRouteInput): Promise<Response> {
  if (!input.caller) return json(401, { error: "unauthenticated" });
  try {
    return json(200, await runPolicyCommand(service, input.command, { actor: input.caller.actor, organizationId: input.caller.organizationId }, input.params));
  } catch (error) {
    const mapped = policyErrorToHttp(error);
    if (mapped) return json(mapped.status, mapped.body);
    throw error;
  }
}

/** Thrown by `assertAuthorized`; `result` is for your logs, never for the client (it names the policies that applied). */
export class PolicyDeniedError extends AuthorizationDeniedError {
  readonly result: AuthorizationResult;
  constructor(result: AuthorizationResult) {
    super("Authorization denied");
    this.name = "PolicyDeniedError";
    this.result = result;
  }
}

/**
 * Guard for Server Actions/Route Handlers over `engine.authorize()`: the role decision AND the organization's active policies.
 * Throws instead of returning a boolean, so a caller can't continue past a refusal by forgetting to look at a result. `deny` and
 * `indeterminate` both throw. Returns the (allowed) result when you want to log which policies applied.
 */
export async function assertAuthorized(engine: AuthorizationEngine, input: AuthorizeInput): Promise<AuthorizationResult> {
  const result = await engine.authorize(input);
  if (result.allowed !== true) throw new PolicyDeniedError(result);
  return result;
}

/**
 * Route Handler helper like `authorizeRoute`, over `engine.authorize()`: `null` when allowed, a ready-to-return 403 otherwise.
 * The body never includes the policies or the reason.
 */
export async function authorizeResourceRoute(engine: AuthorizationEngine, input: AuthorizeInput): Promise<Response | null> {
  const result = await engine.authorize(input);
  return result.allowed === true ? null : json(403, { error: "forbidden" });
}
