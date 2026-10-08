import { invitationErrorToHttp } from "@uniora/core";
import type { Identity, InvitationService } from "@uniora/core";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Route Handler for the accept page's data: `GET` with the token from the route. Answers
 * `200 { organizationName, email, roleNames, teamNames, expiresAt }`, or the same `404 invalid_invitation` for
 * every unusable token.
 */
export async function previewInvitationRoute(service: InvitationService, token: string | undefined): Promise<Response> {
  const preview = typeof token === "string" && token ? await service.preview(token) : null;
  if (!preview) return json(404, { error: "invalid_invitation" });
  return json(200, {
    organizationName: preview.organizationName,
    email: preview.email,
    roleNames: preview.roleNames,
    teamNames: preview.teamNames,
    expiresAt: preview.expiresAt.toISOString(),
  });
}

export interface AcceptInvitationRouteInput {
  token: string | undefined;
  /** The signed-in caller, or `null` when unauthenticated (answers 401). */
  caller: { identity: Identity; verifiedEmail: string } | null | undefined;
}

/**
 * Route Handler for accepting an invitation. `caller.verifiedEmail` must be the address your auth
 * provider verified (an adapter's `toVerifiedEmail`), never a value from the request body. Every
 * failure is mapped with `invitationErrorToHttp`; unexpected errors are rethrown.
 */
export async function acceptInvitationRoute(service: InvitationService, input: AcceptInvitationRouteInput): Promise<Response> {
  if (!input.caller) return json(401, { error: "unauthenticated" });
  try {
    const result = await service.accept({
      token: input.token ?? "",
      identity: input.caller.identity,
      verifiedEmail: input.caller.verifiedEmail,
    });
    return json(200, {
      organizationId: result.invitation.organizationId,
      membershipId: result.membership.id,
      alreadyMember: result.alreadyMember,
      teamIds: result.teams.map((row) => row.teamId),
      teamsSkipped: result.teamsSkipped,
    });
  } catch (error) {
    const mapped = invitationErrorToHttp(error);
    if (mapped) return json(mapped.status, mapped.body);
    throw error;
  }
}
