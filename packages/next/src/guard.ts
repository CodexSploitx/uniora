import type { AccessCheckInput, AuthorizationEngine, CanInput } from "@uniora/core";

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
export async function assertCan(engine: AuthorizationEngine, input: CanInput): Promise<void> {
  const allowed = await engine.can(input);
  if (!allowed) throw new AuthorizationDeniedError();
}

/** Same as `assertCan`, but for `engine.access.check()` (permission + feature). */
export async function assertAccess(engine: AuthorizationEngine, input: AccessCheckInput): Promise<void> {
  const allowed = await engine.access.check(input);
  if (!allowed) throw new AuthorizationDeniedError();
}
