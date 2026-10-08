import { runTeamCommand, teamErrorToHttp } from "@uniora/core";
import type { Identity, TeamCommand, TeamService } from "@uniora/core";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface TeamCommandRouteInput {
  /** Which team command this route is. Fixed per route: the client never picks it. */
  command: TeamCommand;
  /**
   * The signed-in caller and the organization they work in, from your session or route, never from the request body.
   * `null` when nobody is signed in (answers 401). The service still checks the caller's rights in that organization.
   */
  caller: { actor: Identity; organizationId: string } | null | undefined;
  /** The untrusted input: the parsed JSON body with the route params on top (`{ ...body, ...params }`). Unknown fields are rejected. */
  params: unknown;
}

/**
 * Route Handler body for one team command over a `TeamService`:
 *
 * ```ts
 * export async function POST(request: Request, { params }: { params: { teamId: string } }) {
 *   return teamCommandRoute(teams, { command: "addMember", caller: await currentCaller(), params: { ...(await request.json()), ...params } });
 * }
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated and `teamErrorToHttp` for every `TeamError` (403 never says
 * why); unexpected errors are rethrown. Hand this the SERVICE, never `storage.teams`.
 */
export async function teamCommandRoute(service: TeamService, input: TeamCommandRouteInput): Promise<Response> {
  if (!input.caller) return json(401, { error: "unauthenticated" });
  try {
    return json(200, await runTeamCommand(service, input.command, { actor: input.caller.actor, organizationId: input.caller.organizationId }, input.params));
  } catch (error) {
    const mapped = teamErrorToHttp(error);
    if (mapped) return json(mapped.status, mapped.body);
    throw error;
  }
}
