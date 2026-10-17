import type { AccessCheckInput, AuthorizationEngine, CanInput, IdentityProfile, ProfileSync } from "@uniora/core";

/**
 * Keeps the stored profile (name, e-mail, avatar) of the caller current: pass `createProfileSync(storage)` from `@uniora/core` and the
 * `profile` your auth adapter returned (`resolveIdentityWithProfile`). The first request of every person, new or long-standing, stores
 * it; afterwards it is written only when it changes. It runs for the identity of the check, whether or not the check then allows it,
 * and never throws. Display data only: it is never part of the decision.
 */
export interface ProfileSyncHook {
  syncProfile?: ProfileSync;
  profile?: IdentityProfile;
}

/**
 * Thrown by `assertCan`/`assertAccess` when the check fails. Deliberately a
 * plain thrown error, not a redirect/notFound call: `@uniora/next` has no
 * hard dependency on the `next` package (see package description), and a
 * host app's Server Action typically wants to catch this itself and decide
 * how to surface it (return `{ error }`, redirect, log) rather than have
 * this package assume a UI flow it cannot know.
 */
export class AuthorizationDeniedError extends Error {
  constructor(message = "Authorization denied") {
    super(message);
    this.name = "AuthorizationDeniedError";
  }
}

/**
 * Guard for Server Actions/Route Handlers: throws `AuthorizationDeniedError`
 * instead of returning a boolean, so a caller can never accidentally
 * continue past a denied check by forgetting to inspect a return value
 * (fail-closed by construction, not by discipline — uniora-security-engineering
 * INV-010). Delegates to `engine.can()` unchanged.
 */
export async function assertCan(engine: AuthorizationEngine, input: CanInput, options: ProfileSyncHook = {}): Promise<void> {
  if (options.syncProfile && options.profile) await options.syncProfile(input.identity, options.profile);
  const allowed = await engine.can(input);
  if (!allowed) throw new AuthorizationDeniedError();
}

/** Same as `assertCan`, but for `engine.access.check()` (permission + feature). */
export async function assertAccess(engine: AuthorizationEngine, input: AccessCheckInput, options: ProfileSyncHook = {}): Promise<void> {
  if (options.syncProfile && options.profile) await options.syncProfile(input.identity, options.profile);
  const allowed = await engine.access.check(input);
  if (!allowed) throw new AuthorizationDeniedError();
}
