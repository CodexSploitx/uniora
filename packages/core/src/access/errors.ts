import { UnioraError } from "../shared/errors.js";

export type AccessErrorCode =
  /** The actor does not hold the permission the operation needs (the plain "no"). */
  | "access_forbidden"
  /** Nobody changes their own roles, status or membership: ask someone else. */
  | "access_self_change"
  /** The role holds permissions the actor does not hold, so the actor cannot give it, offer it or put those permissions into a role. */
  | "access_escalation"
  /** The member (or the role) holds more power than the actor, so the actor cannot touch it. */
  | "access_target_stronger"
  /** The Owner role moves only through `assignOwnerRole` / `unassignOwnerRole` / `transferOwnership`, never through the access service. */
  | "access_owner_protected"
  /** A write reached a guarded storage without a valid `AccessAuthorization`. */
  | "access_authorization_required"
  /** The service was given a storage that is not wrapped by `createGuardedStorage` (and `allowUnguardedStorage` is off). */
  | "access_storage_not_guarded"
  | "access_invalid";

export class AccessError extends UnioraError {
  constructor(message: string, code: AccessErrorCode = "access_invalid") {
    super(message, code);
    this.name = "AccessError";
  }
}

/** The refusals that come after the actor passed the permission gate: they are audited as `access.change_refused`. */
export const ACCESS_RULE_REFUSALS: ReadonlySet<string> = new Set(["access_self_change", "access_escalation", "access_target_stronger", "access_owner_protected"]);
