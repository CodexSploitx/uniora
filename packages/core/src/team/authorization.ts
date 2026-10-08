import type { Identity } from "../identity/types.js";
import { TeamError } from "./repository.js";

/** The writes that need authorization. One token lists the ones it covers. */
export const TEAM_OPERATIONS = [
  "team.create",
  "team.update",
  "team.archive",
  "team.restore",
  "team.delete",
  "member.add",
  "member.status",
  "member.accept",
  "member.responsibility",
  "member.role",
] as const;
export type TeamOperation = (typeof TEAM_OPERATIONS)[number];

declare const authorizationBrand: unique symbol;

/**
 * Proof that a team change was authorized. Every write of `storage.teams` and `storage.teamMemberships` requires one and
 * the storage verifies it, so a team change cannot happen "by accident" from code that skipped the permission check.
 *
 * It cannot be built by hand: it is an opaque object that only `createTeamService` (after asking the authorization
 * engine) and `createTrustedTeamStorage` (explicit back-office use) can issue. A copy, a spread or a look-alike object is
 * refused. It is bound to one organization, one actor and a list of operations, and expires after 60 seconds.
 */
export interface TeamAuthorization {
  readonly [authorizationBrand]: true;
  readonly organizationId: string;
  readonly actor: Identity;
}

interface Issued {
  organizationId: string;
  actor: Identity;
  operations: ReadonlySet<TeamOperation>;
  expiresAt: number;
  trusted: boolean;
}

const REGISTRY = Symbol.for("uniora.team-authorization.registry");
const TTL_MS = 60_000;

// One registry per process, shared by every copy of this module that gets loaded (a bundler or Next.js can load a package
// twice), so a token issued by one copy is still recognised by the other. Nothing outside this file can reach into it.
const issued: WeakMap<object, Issued> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new WeakMap<object, Issued>()) as WeakMap<object, Issued>;

/**
 * Issues a token. Not exported from the package: only the team service and the trusted wrapper (both inside `@uniora/core`)
 * can call it. `trusted` marks tokens that did not come from an engine decision (back-office, imports, tests).
 */
export function issueTeamAuthorization(
  organizationId: string,
  actor: Identity,
  operations: readonly TeamOperation[],
  options: { trusted?: boolean; now?: number } = {},
): TeamAuthorization {
  const token = Object.freeze({ organizationId, actor: Object.freeze({ ...actor }) }) as unknown as TeamAuthorization;
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
 * Called by every storage backend at the top of each team write. Throws `team_authorization_required` unless `authorization`
 * is a live token issued for exactly this organization and this operation (and, when the call names an actor, for that actor).
 * Fail-closed: anything else (missing, forged, copied, expired, for another organization or operation) is refused.
 */
export function assertTeamAuthorization(
  authorization: unknown,
  expected: { organizationId: string; operation: TeamOperation; actor?: Identity },
): void {
  const fail = (why: string): never => {
    throw new TeamError(`This team change was not authorized (${why}). Use the team service.`, "team_authorization_required");
  };
  if (typeof authorization !== "object" || authorization === null) return fail("missing");
  const token = issued.get(authorization);
  if (!token) return fail("unrecognized");
  if (token.expiresAt < Date.now()) return fail("expired");
  if (token.organizationId !== expected.organizationId) return fail("another organization");
  if (!token.operations.has(expected.operation)) return fail("another operation");
  // A trusted (back-office) token is not tied to the actor named in the call: an import may act on behalf of anyone.
  if (!token.trusted && expected.actor && (expected.actor.provider !== token.actor.provider || expected.actor.subject !== token.actor.subject)) {
    return fail("another actor");
  }
}
