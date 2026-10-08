import { runTeamCommand, teamErrorToHttp } from "@uniora/core";
import type { Identity, TeamCommand, TeamService } from "@uniora/core";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
type NextLike = (err?: unknown) => void;
type Awaitable<T> = T | Promise<T>;

export interface TeamCommandOptions<Req> {
  /** Which team command this route is (`"addMember"`, `"moveMember"`, ...). Fixed per route: the client never picks it. */
  command: TeamCommand;
  /**
   * The signed-in caller and the organization they are working in, from YOUR session or route, never from the request
   * body. Return `null`/`undefined` when nobody is signed in: the route answers 401. The service still checks the caller's
   * rights in that organization.
   */
  resolve: (req: Req) => Awaitable<{ actor: Identity; organizationId: string } | null | undefined>;
  /**
   * The untrusted input. Default: `req.body` with `req.params` on top (a `/teams/:teamId` in the path wins over a `teamId`
   * in the body). Unknown fields are rejected by the command.
   */
  params?: (req: Req) => unknown;
}

/**
 * One route for one team command, over a `TeamService`:
 *
 * ```ts
 * app.post("/teams/:teamId/members", teamCommand(teams, { command: "addMember", resolve }));
 * app.patch("/teams/:teamId", teamCommand(teams, { command: "updateTeam", resolve }));
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated and `teamErrorToHttp` for every `TeamError` (403 never says
 * why); anything unexpected goes to `next(err)`. Hand this the SERVICE, never `storage.teams`: only the service checks
 * what the caller may do.
 */
export function teamCommand<Req = unknown>(service: TeamService, options: TeamCommandOptions<Req>) {
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
      const result = await runTeamCommand(service, options.command, { actor: caller.actor, organizationId: caller.organizationId }, params);
      res.status(200).json(result);
    } catch (error) {
      const mapped = teamErrorToHttp(error);
      if (mapped) res.status(mapped.status).json(mapped.body);
      else next(error);
    }
  };
}
