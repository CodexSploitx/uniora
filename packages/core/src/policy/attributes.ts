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

/** Namespaces reserved for later phases (time, request context, parent scopes): a definition that uses one is refused. */
export const RESERVED_NAMESPACES = ["environment", "context", "request", "session"] as const;

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
