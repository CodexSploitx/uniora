import type { Identity } from "../identity/types.js";

/**
 * `active` members are evaluated normally. `blocked` members stay in the organization (roles, history and
 * audit trail intact) but are denied EVERYTHING: `can()`, `access.check()` and authorization snapshots all
 * answer `false`. Blocking is reversible (`unblock`), unlike removing the membership.
 *
 * `suspended` is a block with an end date (`suspend(id, { actor, until })`): denied exactly like `blocked` until
 * `until`, then the status reads `active` again on its own, with no job to run — every read (and the SQL functions
 * for RLS) compares the date with the clock. `blocked` stays indefinite until `unblock`.
 */
export type MembershipStatus = "active" | "suspended" | "blocked";

/** Why and by whom a membership is currently blocked or suspended. Cleared by `unblock` (the audit trail keeps the history). */
export interface MembershipBlock {
  readonly at: Date;
  readonly by: Identity;
  readonly reason?: string;
  /** End of a suspension (set exactly when `status` is `suspended`). Once it passes, the membership is `active` again. */
  readonly until?: Date;
}

/**
 * The relation between an Identity and an Organization (docs/PROYECT.md §5).
 * A single identity can hold multiple memberships across organizations.
 */
export interface Membership {
  readonly id: string;
  readonly organizationId: string;
  readonly identity: Identity;
  roleIds: string[];
  status: MembershipStatus;
  /** Since when the identity belongs to the organization. Memberships that predate this field carry the migration time. */
  readonly createdAt: Date;
  /** Last change to the membership itself: roles assigned/removed, blocked/unblocked. */
  readonly updatedAt: Date;
  /** Who invited the member, when the membership came from an invitation (or the caller said so on creation). */
  readonly invitedBy?: Identity;
  /** Last time the application reported the member as active (`recordActivity`). Absent until it does. */
  readonly lastActiveAt?: Date;
  /** Present exactly while `status` is `blocked` or `suspended`. */
  readonly blocked?: MembershipBlock;
  /**
   * Starts at 1 and goes up by one on every explicit change (a role assigned or removed, `block`, `suspend`,
   * `unblock`; a call that changes nothing, `recordActivity` and the automatic end of a suspension do not count).
   * Pass it back as `expectedVersion` so an edit made from a stale copy fails (`membership_version_conflict`)
   * instead of overwriting a newer one.
   */
  version: number;
}
