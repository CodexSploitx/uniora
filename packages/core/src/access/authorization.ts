import type { Identity } from "../identity/types.js";
import { AccessError } from "./errors.js";

/** The guarded writes. A token names exactly one of them. */
export const ACCESS_OPERATIONS = [
  "member.create",
  "member.role.assign",
  "member.role.unassign",
  "member.owner",
  "member.status",
  "member.delete",
  "role.create",
  "role.edit",
  "role.permissions",
  "role.delete",
  "invitation.create",
  "invitation.manage",
] as const;
export type AccessOperation = (typeof ACCESS_OPERATIONS)[number];

declare const authorizationBrand: unique symbol;

/**
 * Proof that a change to who holds which power was authorized. A storage wrapped by `createGuardedStorage` refuses every
 * such write (a role given to a member, a member created with roles, an invitation, a role's permissions, a block, a removal)
 * unless it carries one, so no code path can hand out power "by accident" without going through the access service (or the
 * explicitly named trusted entry point).
 *
 * It cannot be built by hand: it is an opaque object that only `createAccessAdminService` and the invitation service
 * (after the rules passed), the library's own founding flows and `createTrustedAccessStorage` can issue. A copy, a spread or
 * a look-alike is refused. It names ONE operation on ONE target (for example "give role R to membership M"), is usable ONCE
 * and expires after 60 seconds, so a token that leaks in a log line or a captured argument cannot be replayed or pointed at
 * something else. Code running inside the process can still reach the registry (see guides/access-admin.md).
 */
export interface AccessAuthorization {
  readonly [authorizationBrand]: true;
  readonly actor: Identity;
}

/** The optional last argument of a guarded write. A backend ignores it; the guard verifies it. */
export interface AccessWriteOptions {
  authorization?: AccessAuthorization;
}

interface Issued {
  actor: Identity;
  operation: AccessOperation;
  organizationId: string | undefined;
  target: string;
  detail: string | undefined;
  expiresAt: number;
  trusted: boolean;
  used: boolean;
}

const REGISTRY = Symbol.for("uniora.access-authorization.registry");
const TTL_MS = 60_000;

// One registry per process, shared by every copy of this module that gets loaded (a bundler or Next.js can load a package
// twice), so a token issued by one copy is still recognised by the other. Nothing outside this file can reach into it.
const issued: WeakMap<object, Issued> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new WeakMap<object, Issued>()) as WeakMap<object, Issued>;

/** What a token is bound to. `detail` is whatever else the write is about (the role, the permission keys, the method). */
export interface AccessBinding {
  operation: AccessOperation;
  /** The id the write is about: a membership, a role, an invitation, or the id the new row will get. */
  target: string;
  detail?: string;
  /** Known for the writes that name their organization (creations); when given, the token must be for the same one. */
  organizationId?: string;
}

/** A stable text for a set of ids or keys, the same whatever the order and the repeats. */
export function accessSet(values: Iterable<string> | undefined): string {
  return JSON.stringify([...new Set(values ?? [])].sort());
}

/**
 * Issues a token. Not exported from the package: only the access service, the invitation service, the founding flows and the
 * trusted wrapper (all inside `@uniora/core`) can call it. `trusted` marks tokens that did not come from an engine decision.
 */
export function issueAccessAuthorization(
  actor: Identity,
  binding: AccessBinding,
  options: { trusted?: boolean; now?: number } = {},
): AccessAuthorization {
  const token = Object.freeze({ actor: Object.freeze({ ...actor }) }) as unknown as AccessAuthorization;
  issued.set(token, {
    actor: { ...actor },
    operation: binding.operation,
    organizationId: binding.organizationId,
    target: binding.target,
    detail: binding.detail,
    expiresAt: (options.now ?? Date.now()) + TTL_MS,
    trusted: options.trusted === true,
    used: false,
  });
  return token;
}

/**
 * Called by the guard at the top of each guarded write. Throws `access_authorization_required` unless `authorization` is a live,
 * unused token issued for exactly this operation on exactly this target (and, when the call names an actor, for that actor).
 * Fail-closed: anything else (missing, forged, copied, expired, reused, for another operation, target or organization) is refused.
 */
export function assertAccessAuthorization(authorization: unknown, expected: AccessBinding & { actor?: Identity }): void {
  const fail = (why: string): never => {
    throw new AccessError(
      `This change to roles or members was not authorized (${why}). Use the access service, or a trusted storage for back-office code.`,
      "access_authorization_required",
    );
  };
  if (typeof authorization !== "object" || authorization === null) return fail("missing");
  const token = issued.get(authorization);
  if (!token) return fail("unrecognized");
  if (token.used) return fail("already used");
  if (token.expiresAt < Date.now()) return fail("expired");
  if (token.operation !== expected.operation) return fail("another operation");
  if (token.target !== expected.target) return fail("another target");
  if ((token.detail ?? "") !== (expected.detail ?? "")) return fail("another change");
  if (expected.organizationId !== undefined && token.organizationId !== undefined && token.organizationId !== expected.organizationId) {
    return fail("another organization");
  }
  // A trusted (back-office) token is not tied to the actor named in the call: an import may act on behalf of anyone.
  if (!token.trusted && expected.actor && (expected.actor.provider !== token.actor.provider || expected.actor.subject !== token.actor.subject)) {
    return fail("another actor");
  }
  token.used = true;
}
