import { describe, expect, it } from "vitest";
import { invitationErrorToHttp } from "./http.js";
import { InvitationError, type InvitationFailureReason } from "./repository.js";

describe("invitationErrorToHttp", () => {
  it.each<InvitationFailureReason>(["invalid", "expired", "revoked", "already_accepted", "email_mismatch", "roles_unavailable"])(
    "answers the same generic 400 for %s",
    (reason) => {
      expect(invitationErrorToHttp(new InvitationError("specific detail", reason))).toEqual({
        status: 400,
        body: { error: "invalid_invitation", message: "This invitation is invalid or has expired." },
      });
    },
  );

  it("tells throttling, duplicates and malformed input apart", () => {
    expect(invitationErrorToHttp(new InvitationError("slow down", "rate_limited"))).toMatchObject({ status: 429 });
    expect(invitationErrorToHttp(new InvitationError("wait", "cooldown"))).toMatchObject({ status: 429 });
    expect(invitationErrorToHttp(new InvitationError("dup", "duplicate_pending"))).toMatchObject({ status: 409 });
    expect(invitationErrorToHttp(new InvitationError("key", "idempotency_conflict"))).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
    expect(invitationErrorToHttp(new InvitationError("bad", "bad_request"))).toMatchObject({ status: 400, body: { error: "bad_request" } });
  });

  it("leaves unexpected errors alone", () => {
    expect(invitationErrorToHttp(new Error("database down"))).toBeNull();
    expect(invitationErrorToHttp("nope")).toBeNull();
  });
});
