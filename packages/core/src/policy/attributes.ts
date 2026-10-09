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
} as const satisfies Record<string, AttributeType>;

/** What the host says about the resource, besides the attributes a policy declares. */
export const RESOURCE_ATTRIBUTES = {
  "resource.id": "string",
  /** The ids of the teams the resource belongs to. An empty list means "no team", which is a fact; an absent value is unknown. */
  "resource.teamIds": "string[]",
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
