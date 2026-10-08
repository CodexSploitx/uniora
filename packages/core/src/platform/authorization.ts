import type { Identity } from "../identity/types.js";
import { PlatformError } from "./errors.js";

/** The writes that need authorization. One token lists the ones it covers. */
export const PLATFORM_OPERATIONS = [
  "bootstrap",
  "role.create",
  "role.update",
  "role.delete",
  "member.add",
  "member.status",
  "member.role",
  "member.remove",
] as const;
export type PlatformOperation = (typeof PLATFORM_OPERATIONS)[number];

declare const authorizationBrand: unique symbol;

/**
 * Proof that a change to platform roles or members was authorized. Every write of `platformRoles` and `platformMembers`
 * requires one and the storage verifies it, so no code path can change who holds platform power "by accident" without
 * going through the platform service (or the explicitly named trusted/bootstrap entry points).
 *
 * It cannot be built by hand: it is an opaque object that only `createPlatformService` (after asking the platform engine),
 * `bootstrapPlatform` and `createTrustedPlatformStorage` can issue. A copy, a spread or a look-alike is refused. It is bound
 * to one actor and a list of operations, and expires after 60 seconds. Nothing about an organization can produce one.
 */
export interface PlatformAuthorization {
  readonly [authorizationBrand]: true;
  readonly actor: Identity;
}

interface Issued {
  actor: Identity;
  operations: ReadonlySet<PlatformOperation>;
  expiresAt: number;
  trusted: boolean;
}

const REGISTRY = Symbol.for("uniora.platform-authorization.registry");
const TTL_MS = 60_000;

// One registry per process, shared by every copy of this module that gets loaded (a bundler can load a package twice).
const issued: WeakMap<object, Issued> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new WeakMap<object, Issued>()) as WeakMap<object, Issued>;

/** Not exported from the package. `trusted` marks tokens that did not come from an engine decision (bootstrap, back-office). */
export function issuePlatformAuthorization(
  actor: Identity,
  operations: readonly PlatformOperation[],
  options: { trusted?: boolean; now?: number } = {},
): PlatformAuthorization {
  const token = Object.freeze({ actor: Object.freeze({ ...actor }) }) as unknown as PlatformAuthorization;
  issued.set(token, {
    actor: { ...actor },
    operations: new Set(operations),
    expiresAt: (options.now ?? Date.now()) + TTL_MS,
    trusted: options.trusted === true,
  });
  return token;
}

/**
 * Called by every storage backend at the top of each platform write. Throws `platform_authorization_required` unless
 * `authorization` is a live token issued for this operation (and, when the call names an actor, for that actor). Fail-closed.
 */
export function assertPlatformAuthorization(authorization: unknown, expected: { operation: PlatformOperation; actor?: Identity }): void {
  const fail = (why: string): never => {
    throw new PlatformError(`This platform change was not authorized (${why}). Use the platform service.`, "platform_authorization_required");
  };
  if (typeof authorization !== "object" || authorization === null) return fail("missing");
  const token = issued.get(authorization);
  if (!token) return fail("unrecognized");
  if (token.expiresAt < Date.now()) return fail("expired");
  if (!token.operations.has(expected.operation)) return fail("another operation");
  if (!token.trusted && expected.actor && (expected.actor.provider !== token.actor.provider || expected.actor.subject !== token.actor.subject)) {
    return fail("another actor");
  }
}
