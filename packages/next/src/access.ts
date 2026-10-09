import { accessErrorToHttp, runAccessCommand } from "@uniora/core";
import type { AccessCommand, AccessServices, Identity } from "@uniora/core";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface AccessCommandRouteInput {
  /** Which access command this route is. Fixed per route: the client never picks it. */
  command: AccessCommand;
  /**
   * The signed-in caller and the organization they work in, from your session or route, never from the request body.
   * `null` when nobody is signed in (answers 401). The services still check the caller's rights in that organization.
   */
  caller: { actor: Identity; organizationId: string } | null | undefined;
  /** The untrusted input: the parsed JSON body with the route params on top (`{ ...body, ...params }`). Unknown fields are rejected. */
  params: unknown;
  /** Return the secret accept link of `inviteMember` / `resendInvitation` in the response. Default `false`. */
  includeAcceptUrl?: boolean;
}

/**
 * Route Handler body for one access command over the services that decide who may give which power to whom:
 *
 * ```ts
 * export async function PUT(request: Request, { params }: { params: { membershipId: string; roleId: string } }) {
 *   return accessCommandRoute({ access }, { command: "assignRole", caller: await currentCaller(), params });
 * }
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated and `accessErrorToHttp` for every refusal (`403`, with a `reason` when
 * a rule stopped someone who had the permission); unexpected errors are rethrown. Hand this the SERVICES, never `storage.memberships`.
 */
export async function accessCommandRoute(services: AccessServices, input: AccessCommandRouteInput): Promise<Response> {
  if (!input.caller) return json(401, { error: "unauthenticated" });
  try {
    return json(
      200,
      await runAccessCommand(
        services,
        input.command,
        { actor: input.caller.actor, organizationId: input.caller.organizationId, ...(input.includeAcceptUrl ? { includeAcceptUrl: true } : {}) },
        input.params,
      ),
    );
  } catch (error) {
    const mapped = accessErrorToHttp(error);
    if (mapped) return json(mapped.status, mapped.body);
    throw error;
  }
}
