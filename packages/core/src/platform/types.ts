import type { Identity } from "../identity/types.js";

/** The key of the one role UNIORA creates itself when the platform is initialised: it holds every platform permission. */
export const PLATFORM_ADMIN_ROLE_KEY = "platform_admin";

/**
 * A named set of PLATFORM permissions (`platform.*`). Platform roles live in their own tables and are never mixed with the
 * roles of an organization: holding one grants nothing inside an organization and the other way round.
 */
export interface PlatformRole {
  readonly id: string;
  /** Stable handle, unique across the platform (`platform_admin`, `support`, `billing_ops`). */
  readonly key: string;
  name: string;
  description?: string;
  /** Sorted, unique `platform.*` keys. A trailing `.*` covers everything under that prefix (`platform.organizations.*`). */
  permissions: string[];
  /** Created by UNIORA itself (`platform_admin`). It cannot be edited, renamed or deleted. */
  readonly isSystem: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Starts at 1 and goes up on every change; pass it back as `expectedVersion` to refuse edits made from a stale copy. */
  readonly version: number;
}

/** `active` can act. `suspended` keeps the record and its roles but is denied everything until reactivated. */
export const PLATFORM_MEMBER_STATUSES = ["active", "suspended"] as const;
export type PlatformMemberStatus = (typeof PLATFORM_MEMBER_STATUSES)[number];

export interface PlatformStatusChange {
  readonly at: Date;
  readonly by: Identity;
  readonly reason?: string;
}

/**
 * A person (an identity of the host's auth provider) who administers the platform itself rather than one organization.
 * It is unrelated to organization memberships: the same identity may hold both, and neither one affects the other.
 */
export interface PlatformMember {
  readonly id: string;
  /** The exact identity. Links between identities are NOT followed: platform power never travels through an identity link. */
  readonly identity: Identity;
  status: PlatformMemberStatus;
  /** Ids of platform roles. Sorted, unique, at most 10. */
  roleIds: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly addedBy: Identity;
  readonly statusChange?: PlatformStatusChange;
  readonly version: number;
}
