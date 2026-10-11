import { AccessError } from "../access/errors.js";
import { InvitationError } from "./repository.js";

/** An HTTP answer for a failed invitation operation, safe to send to whoever holds the link. */
export interface InvitationHttpError {
  status: 400 | 403 | 409 | 429;
  body: { error: string; message: string };
}

/**
 * Maps an `InvitationError` to the response a public accept/preview route should send, or `null` for
 * anything else (let it propagate: it's a bug or an outage, not the caller's mistake).
 *
 * Every way an accept can fail (unknown, expired, revoked, already used, wrong e-mail, roles gone)
 * collapses into the same `400 invalid_invitation`, so the response can't be used to probe which
 * links or addresses exist. Only throttling and malformed input are told apart.
 */
export function invitationErrorToHttp(error: unknown): InvitationHttpError | null {
  // The access rules of `createInvitationService({ access })`: the caller (an administrator) may not invite with that role.
  if (error instanceof AccessError && error.code !== "access_authorization_required" && error.code !== "access_storage_not_guarded") {
    if (error.code === "access_forbidden") return { status: 403, body: { error: "forbidden", message: "You are not allowed to do that." } };
    return { status: 403, body: { error: "forbidden", message: error.message } };
  }
  if (!(error instanceof InvitationError)) return null;
  switch (error.reason) {
    case "rate_limited":
    case "cooldown":
      return { status: 429, body: { error: "rate_limited", message: error.message } };
    case "already_member":
      return { status: 409, body: { error: "already_member", message: error.message } };
    case "idempotency_conflict":
      return { status: 409, body: { error: "idempotency_conflict", message: error.message } };
    case "duplicate_pending":
      return { status: 409, body: { error: "duplicate_pending", message: error.message } };
    case "teams_forbidden":
      return { status: 403, body: { error: "teams_forbidden", message: error.message } };
    case "bad_request":
      return { status: 400, body: { error: "bad_request", message: error.message } };
    default:
      return { status: 400, body: { error: "invalid_invitation", message: "This invitation is invalid or has expired." } };
  }
}
