import { accessErrorToHttp, runAccessCommand } from "@uniora/core";
import type { AccessCommand, AccessServices, Identity } from "@uniora/core";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
type NextLike = (err?: unknown) => void;
type Awaitable<T> = T | Promise<T>;

export interface AccessCommandOptions<Req> {
  /** Which access command this route is (`"assignRole"`, `"inviteMember"`, ...). Fixed per route: the client never picks it. */
  command: AccessCommand;
  /**
   * The signed-in caller and the organization they are working in, from YOUR session or route, never from the request
   * body. Return `null`/`undefined` when nobody is signed in: the route answers 401. The services still check the caller's
   * rights in that organization.
   */
  resolve: (req: Req) => Awaitable<{ actor: Identity; organizationId: string } | null | undefined>;
  /**
   * The untrusted input. Default: `req.body` with `req.params` on top (a `/members/:membershipId` in the path wins over a
   * `membershipId` in the body). Unknown fields are rejected by the command.
   */
  params?: (req: Req) => unknown;
  /** Return the secret accept link of `inviteMember` / `resendInvitation` in the response. Default `false`. */
  includeAcceptUrl?: boolean;
}

/**
 * One route for one access command (give or take a role, block a member, edit a role, invite...), over the services that
 * decide who may give which power to whom:
 *
 * ```ts
 * const access = createAccessAdminService({ storage: guarded });
 * app.put("/members/:membershipId/roles/:roleId", accessCommand({ access }, { command: "assignRole", resolve }));
 * app.post("/invitations", accessCommand({ access, invitations }, { command: "inviteMember", resolve }));
 * ```
 *
 * Answers `200` with the result, `401` when unauthenticated and `accessErrorToHttp` for every refusal (`403`, with a `reason` when a
 * rule stopped someone who had the permission); anything unexpected goes to `next(err)`. Hand this the SERVICES, never
 * `storage.memberships`: only the services check what the caller may do.
 */
export function accessCommand<Req = unknown>(services: AccessServices, options: AccessCommandOptions<Req>) {
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
      const result = await runAccessCommand(
        services,
        options.command,
        { actor: caller.actor, organizationId: caller.organizationId, ...(options.includeAcceptUrl ? { includeAcceptUrl: true } : {}) },
        params,
      );
      res.status(200).json(result);
    } catch (error) {
      const mapped = accessErrorToHttp(error);
      if (mapped) res.status(mapped.status).json(mapped.body);
      else next(error);
    }
  };
}
