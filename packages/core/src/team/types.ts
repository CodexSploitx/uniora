import type { Identity } from "../identity/types.js";

/** `active` is normal operation. `archived` keeps the team and its history for the record but accepts no changes until it is restored. */
export const TEAM_STATUSES = ["active", "archived"] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** Free-form JSON the host application defines and UNIORA never interprets (`type: "branch"`, `costCenter: "ES-BCN-01"`, ...). */
export type TeamData = Record<string, unknown>;

/** Who archived a team, when and why. Present exactly while `status` is `archived`. */
export interface TeamArchive {
  readonly at: Date;
  readonly by: Identity;
  readonly reason?: string;
}

/**
 * An organizational group inside ONE organization: a department, a branch, a project, a region, whatever the host
 * application says it is. A team is context, not authority: belonging to it grants nothing by itself.
 */
export interface Team {
  readonly id: string;
  /** The only organization this team can ever be seen or used from. */
  readonly organizationId: string;
  /** URL-safe handle, unique within the organization. */
  slug: string;
  name: string;
  status: TeamStatus;
  /**
   * The team this one sits under (a branch inside a region, a squad inside a department), in the same organization;
   * absent for a top-level team. Purely organizational: it grants and inherits nothing, and `engine.can({ teamId })` never
   * looks at it. At most 8 levels deep, no cycles.
   */
  parentId?: string;
  /** The host's own identifier for this team in another system (ERP, CRM, HR); unique within the organization. */
  externalId?: string;
  /** Free-form data describing the team to the host application. At most 16 KB of JSON. */
  metadata: TeamData;
  /** Free-form per-team configuration. At most 16 KB of JSON. */
  settings: TeamData;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archived?: TeamArchive;
  /**
   * Starts at 1 and goes up by one on every change (`update`, `archive`, `restore`; a call that changes nothing does not
   * count). Pass it back as `expectedVersion` so an edit made from a stale copy fails (`team_version_conflict`).
   */
  readonly version: number;
}

/**
 * `pending`: invited, has not accepted yet. `active`: belongs to the team. `suspended`: the relation exists but is
 * not usable for now. `removed`: no longer belongs (the row stays for the record and can be re-added).
 */
export const TEAM_MEMBER_STATUSES = ["pending", "active", "suspended", "removed"] as const;
export type TeamMemberStatus = (typeof TEAM_MEMBER_STATUSES)[number];

/**
 * A label that says who looks after a team. It is NOT a permission: being the owner or a manager of a team opens
 * nothing by itself, the authorization engine still decides from roles and permissions.
 */
export const TEAM_RESPONSIBILITIES = ["owner", "manager", "member"] as const;
export type TeamResponsibility = (typeof TEAM_RESPONSIBILITIES)[number];

/** Who moved a team membership to its current status, when and why. */
export interface TeamMemberStatusChange {
  readonly at: Date;
  readonly by: Identity;
  readonly reason?: string;
}

/**
 * The relation between an organization membership and a team (independent of the organization membership itself: a
 * member can belong to no team, to one or to several). `roleIds` are roles OF THE SAME ORGANIZATION that apply only
 * inside this team (a Manager in Barcelona and a plain member in Madrid).
 */
export interface TeamMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly teamId: string;
  /** The organization membership this team membership belongs to. */
  readonly membershipId: string;
  status: TeamMemberStatus;
  responsibility: TeamResponsibility;
  roleIds: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When the member first became `active`. */
  readonly joinedAt?: Date;
  readonly invitedBy?: Identity;
  /** The last status change (who, when, why). */
  readonly statusChange?: TeamMemberStatusChange;
  /** Starts at 1, plus one on every explicit change (see `Team.version`); a stale `expectedVersion` fails with `team_membership_version_conflict`. */
  readonly version: number;
}
