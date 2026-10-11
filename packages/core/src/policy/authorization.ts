import type { Identity } from "../identity/types.js";
import { PolicyError } from "./errors.js";

/** The writes that need authorization. One token lists the ones it covers. */
export const POLICY_OPERATIONS = ["policy.create", "policy.update", "policy.activate", "policy.disable", "policy.retire", "policy.delete"] as const;
export type PolicyOperation = (typeof POLICY_OPERATIONS)[number];

declare const authorizationBrand: unique symbol;

/**
 * Proof that a policy change was authorized. Every write of `storage.policies` requires one and the storage verifies it, so a
 * policy cannot change "by accident" from code that skipped the permission check. It is the same mechanism as `TeamAuthorization`.
 *
 * It cannot be built by hand: it is an opaque object that only `createPolicyService` (after asking the authorization engine)
 * and `createTrustedPolicyStorage` (explicit back-office use) can issue. A copy, a spread or a look-alike object is refused.
 * It is bound to one organization, one actor and a list of operations, and expires after 60 seconds.
 */
export interface PolicyAuthorization {
  readonly [authorizationBrand]: true;
  readonly organizationId: string;
  readonly actor: Identity;
}

interface Issued {
  organizationId: string;
  actor: Identity;
  operations: ReadonlySet<PolicyOperation>;
  expiresAt: number;
  trusted: boolean;
}

const REGISTRY = Symbol.for("uniora.policy-authorization.registry");
const TTL_MS = 60_000;

// One registry per process, shared by every copy of this module that gets loaded (a bundler can load a package twice).
const issued: WeakMap<object, Issued> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new WeakMap<object, Issued>()) as WeakMap<object, Issued>;

/** Not exported from the package: only the policy service and the trusted wrapper (both inside `@uniora/core`) can call it. */
export function issuePolicyAuthorization(
  organizationId: string,
  actor: Identity,
  operations: readonly PolicyOperation[],
  options: { trusted?: boolean; now?: number } = {},
): PolicyAuthorization {
  const token = Object.freeze({ organizationId, actor: Object.freeze({ ...actor }) }) as unknown as PolicyAuthorization;
  issued.set(token, {
    organizationId,
    actor: { ...actor },
    operations: new Set(operations),
    expiresAt: (options.now ?? Date.now()) + TTL_MS,
    trusted: options.trusted === true,
  });
  return token;
}

/**
 * Called by every storage backend at the top of each policy write. Throws `policy_authorization_required` unless `authorization`
 * is a live token issued for exactly this organization and this operation (and, when the call names an actor, for that actor).
 * Fail-closed: anything else (missing, forged, copied, expired, for another organization or operation) is refused.
 */
export function assertPolicyAuthorization(
  authorization: unknown,
  expected: { organizationId: string; operation: PolicyOperation; actor?: Identity },
): void {
  const fail = (why: string): never => {
    throw new PolicyError(`This policy change was not authorized (${why}). Use the policy service.`, "policy_authorization_required");
  };
  if (typeof authorization !== "object" || authorization === null) return fail("missing");
  const token = issued.get(authorization);
  if (!token) return fail("unrecognized");
  if (token.expiresAt < Date.now()) return fail("expired");
  if (token.organizationId !== expected.organizationId) return fail("another organization");
  if (!token.operations.has(expected.operation)) return fail("another operation");
  if (!token.trusted && expected.actor && (expected.actor.provider !== token.actor.provider || expected.actor.subject !== token.actor.subject)) {
    return fail("another actor");
  }
}
