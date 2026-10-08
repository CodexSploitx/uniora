import { platformErrorToHttp, runPlatformCommand } from "@uniora/core";
import type { Identity, PlatformCommand, PlatformEngine, PlatformService } from "@uniora/core";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface PlatformCommandRouteInput {
  /** Which platform command this route is. Fixed per route: the client never picks it. */
  command: PlatformCommand;
  /** The signed-in PLATFORM administrator from your admin session, never from the request body; `null` answers 401. */
  caller: { actor: Identity } | null | undefined;
  /** The untrusted input: the parsed JSON body with the route params on top. Unknown fields are rejected. */
  params: unknown;
}

/**
 * Route Handler body for one platform command over a `PlatformService`:
 *
 * ```ts
 * export async function POST(request: Request) {
 *   return platformCommandRoute(platform, { command: "addMember", caller: await currentPlatformAdmin(), params: await request.json() });
 * }
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated, `428` when a step-up is needed and `platformErrorToHttp` for the
 * rest (403 never says why); unexpected errors are rethrown. Hand this the SERVICE, never the repositories.
 */
export async function platformCommandRoute(service: PlatformService, input: PlatformCommandRouteInput): Promise<Response> {
  if (!input.caller) return json(401, { error: "unauthenticated" });
  try {
    return json(200, await runPlatformCommand(service, input.command, { actor: input.caller.actor }, input.params));
  } catch (error) {
    const mapped = platformErrorToHttp(error);
    if (mapped) return json(mapped.status, mapped.body);
    throw error;
  }
}

/** Thrown by `assertPlatformCan`; turn it into a 403 (or `notFound()`) in your handler. */
export class PlatformDeniedError extends Error {
  readonly permission: string;
  constructor(permission: string) {
    super("You are not allowed to do that.");
    this.name = "PlatformDeniedError";
    this.permission = permission;
  }
}

/** For your own admin Server Actions and Route Handlers: resolves when the person holds the platform permission, throws `PlatformDeniedError` otherwise (fail-closed). */
export async function assertPlatformCan(engine: PlatformEngine, input: { identity: Identity | null | undefined; permission: string }): Promise<void> {
  const allowed = input.identity ? await engine.can({ identity: input.identity, permission: input.permission }).catch(() => false) : false;
  if (!allowed) throw new PlatformDeniedError(input.permission);
}
