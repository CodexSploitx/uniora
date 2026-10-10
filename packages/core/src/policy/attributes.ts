import type { AttributeType } from "./types.js";

/**
 * What the Authorization Engine itself knows about the person asking, read from storage, never from the caller. A
 * condition can read these without declaring them.
 */
export const SUBJECT_ATTRIBUTES = {
  /** The id of the organization membership of the person asking. */
  "subject.membershipId": "string",
  "subject.membershipStatus": "string",
  /** `provider:subject`, as the audit log writes it. */
  "subject.identity": "string",
  /** The keys of the roles the membership holds in the organization (team roles are not included). */
  "subject.roleKeys": "string[]",
  /** The ids of the ACTIVE teams the membership is an ACTIVE member of. A suspended, pending or removed team membership, or an archived team, is not here. */
  "subject.teamIds": "string[]",
  /**
   * The ids of the ACTIVE teams where the member is an ACTIVE member and holds the responsibility `owner` or `manager` (the
   * teams they lead). Combined with `resource.teamPathIds` it is how a manager reaches everything below their team.
   */
  "subject.managedTeamIds": "string[]",
} as const satisfies Record<string, AttributeType>;

/** What the host says about the resource, besides the attributes a policy declares. */
export const RESOURCE_ATTRIBUTES = {
  "resource.id": "string",
  /** The ids of the teams the resource belongs to. An empty list means "no team", which is a fact; an absent value is unknown. */
  "resource.teamIds": "string[]",
  /**
   * `resource.teamIds` together with ALL the ancestors of those teams, read from the team tree at decision time (so moving a team
   * takes effect on the next decision). "The person leads a team above the resource" is
   * `intersects(subject.managedTeamIds, resource.teamPathIds)`; "the person belongs to the resource's team or any team above it" is
   * the same with `subject.teamIds`. A team does not inherit anything by itself: only policies that read this attribute do. Unknown
   * (so the decision is indeterminate) when the tree could not be read, or the resource lists more teams than can be expanded.
   */
  "resource.teamPathIds": "string[]",
} as const satisfies Record<string, AttributeType>;

export type SubjectAttributeName = keyof typeof SUBJECT_ATTRIBUTES;

/**
 * The clock, read by the engine (never by the caller) at the moment of the decision and expressed in the policy's `timezone`
 * (UTC by default). `epochSeconds` does not depend on the timezone: use it for an absolute moment ("until the audit closes").
 */
export const ENVIRONMENT_ATTRIBUTES = {
  /** Seconds since 1970-01-01T00:00:00Z. */
  "environment.epochSeconds": "number",
  "environment.year": "number",
  /** 1 (January) to 12. */
  "environment.month": "number",
  "environment.dayOfMonth": "number",
  /** ISO weekday: 1 (Monday) to 7 (Sunday). */
  "environment.dayOfWeek": "number",
  /** 0 to 23. */
  "environment.hour": "number",
  /** 0 to 1439: `hour * 60 + minute`, to compare a time of day with one comparison (`gte 540` is "from 09:00"). */
  "environment.minuteOfDay": "number",
  /** The local date as the number `YYYYMMDD` (`20261231`), so dates compare with `lt`/`gte` without text parsing. */
  "environment.dateNumber": "number",
} as const satisfies Record<string, AttributeType>;

export type EnvironmentAttributeName = keyof typeof ENVIRONMENT_ATTRIBUTES;

/**
 * Namespaces reserved for later phases: a definition that uses one is refused. `context.*` is not here: it holds the signals a
 * policy declares in its `context` field and your server supplies (see `AuthorizeInput.context`).
 */
export const RESERVED_NAMESPACES = ["request", "session"] as const;

export function isEnvironmentAttribute(ref: string): ref is EnvironmentAttributeName {
  return Object.hasOwn(ENVIRONMENT_ATTRIBUTES, ref);
}

export function isSubjectAttribute(ref: string): ref is SubjectAttributeName {
  return Object.hasOwn(SUBJECT_ATTRIBUTES, ref);
}

export function isBuiltinResourceAttribute(ref: string): boolean {
  return Object.hasOwn(RESOURCE_ATTRIBUTES, ref);
}

/** The permission namespace of policy administration. Policies are never evaluated for it, so no policy can lock anybody out of fixing policies. */
export const PROTECTED_PERMISSION_PREFIX = "policies.";

export function isProtectedPermission(permission: string): boolean {
  return permission.startsWith(PROTECTED_PERMISSION_PREFIX);
}
