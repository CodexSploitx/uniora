import { runAccessCommand, runPolicyCommand, runTeamCommand } from "@uniora/core";
import { errors } from "../errors.js";
import type { RouteContext } from "../route.js";

/** Drops `undefined`s and turns `Date`s into ISO text, the way a JSON body would have arrived at the command layer. */
export const toJson = <T extends object>(value: T): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/** The version of the resource the caller last saw, for `expectedVersion`: from `If-Match`, never from the body. */
export const versioned = (ctx: RouteContext): { expectedVersion?: number } => (ctx.ifMatch !== undefined ? { expectedVersion: ctx.ifMatch } : {});

/** `"7"`: the strong ETag of a resource at version 7. */
export const etag = (version: number): string => `"${version}"`;

/**
 * Runs an access command as the end user the call speaks for. The command and the organization are fixed by the route; the actor
 * comes from the verified headers; `params` was parsed by the route's strict schema and is checked again by the command layer.
 */
export function runAccess(ctx: RouteContext, command: string, organizationId: string, params: object = {}): Promise<unknown> {
  const { actor, access, invitations } = ctx.delegated();
  return runAccessCommand({ access, ...(invitations ? { invitations } : {}) }, command, { actor, organizationId }, toJson(params));
}

export function runTeam(ctx: RouteContext, command: string, organizationId: string, params: object = {}): Promise<unknown> {
  const { actor, teams } = ctx.delegated();
  return runTeamCommand(teams, command, { actor, organizationId }, toJson(params));
}

export function runPolicy(ctx: RouteContext, command: string, organizationId: string, params: object = {}): Promise<unknown> {
  const { actor, policies } = ctx.delegated();
  return runPolicyCommand(policies, command, { actor, organizationId }, toJson(params));
}

/** The invitation routes need the operator to have said how links are built and sent. */
export function requireInvitations(ctx: RouteContext): void {
  if (!ctx.delegated().invitations) throw errors.notImplemented("invitations_not_configured");
}

/** Sets the `ETag` of a resource that carries a `version`, and returns it as the handler's answer. */
export function withEtag<T>(ctx: RouteContext, result: unknown): T {
  const version = (result as { version?: unknown } | null)?.version;
  if (typeof version === "number") ctx.setHeader("ETag", etag(version));
  return result as T;
}
