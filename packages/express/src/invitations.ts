import { invitationErrorToHttp } from "@uniora/core";
import type { Identity, InvitationPreview, InvitationService } from "@uniora/core";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
type NextLike = (err?: unknown) => void;
type Awaitable<T> = T | Promise<T>;

export interface InvitationPreviewOptions<Req> {
  /** The secret token from the request, typically `req.params.token`. Return `undefined` when absent. */
  token: (req: Req) => string | undefined;
}

/**
 * `GET /invite/:token` — what an accept page may show before sign-in (organization, e-mail, roles,
 * expiry). Unusable tokens all answer the same `404 { error: "invalid_invitation" }`.
 */
export function invitationPreview<Req = unknown>(service: InvitationService, options: InvitationPreviewOptions<Req>) {
  return async (req: Req, res: ResponseLike, next: NextLike): Promise<void> => {
    try {
      const token = options.token(req);
      const preview: InvitationPreview | null = typeof token === "string" && token ? await service.preview(token) : null;
      if (!preview) {
        res.status(404).json({ error: "invalid_invitation" });
        return;
      }
      res.status(200).json({
        organizationName: preview.organizationName,
        email: preview.email,
        roleNames: preview.roleNames,
        teamNames: preview.teamNames,
        expiresAt: preview.expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  };
}

export interface InvitationAcceptOptions<Req> {
  token: (req: Req) => string | undefined;
  /**
   * The signed-in caller and the e-mail your auth provider VERIFIED for them (an adapter's
   * `toVerifiedEmail`), never a value taken from the request body. Return `null`/`undefined` when
   * the caller isn't authenticated: the route answers 401.
   */
  resolve: (req: Req) => Awaitable<{ identity: Identity; verifiedEmail: string } | null | undefined>;
}

/**
 * `POST /invite/:token/accept` — the signed-in caller joins the organization. Answers
 * `200 { organizationId, membershipId, alreadyMember, teamIds, teamsSkipped }`. Failures follow `invitationErrorToHttp`
 * (one generic 400 for every way an accept can fail); anything unexpected goes to `next(err)`.
 */
export function acceptInvitation<Req = unknown>(service: InvitationService, options: InvitationAcceptOptions<Req>) {
  return async (req: Req, res: ResponseLike, next: NextLike): Promise<void> => {
    try {
      const caller = await options.resolve(req);
      if (!caller) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const result = await service.accept({
        token: options.token(req) ?? "",
        identity: caller.identity,
        verifiedEmail: caller.verifiedEmail,
      });
      res.status(200).json({
        organizationId: result.invitation.organizationId,
        membershipId: result.membership.id,
        alreadyMember: result.alreadyMember,
        teamIds: result.teams.map((row) => row.teamId),
        teamsSkipped: result.teamsSkipped,
      });
    } catch (error) {
      const mapped = invitationErrorToHttp(error);
      if (mapped) res.status(mapped.status).json(mapped.body);
      else next(error);
    }
  };
}
