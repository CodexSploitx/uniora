import { UnioraError } from "../shared/errors.js";
import { deriveSlug, matchesSlugPattern, MAX_SLUG_LENGTH } from "../shared/slug.js";
import type { Identity } from "../identity/types.js";
import type { TeamAuthorization } from "./authorization.js";
import type { Team, TeamData, TeamMemberStatus, TeamMembership, TeamResponsibility, TeamStatus } from "./types.js";
import { TEAM_MEMBER_STATUSES, TEAM_RESPONSIBILITIES } from "./types.js";

export type TeamErrorCode =
  | "team_not_found"
  | "team_exists"
  | "team_slug_taken"
  | "team_external_id_taken"
  | "team_name_invalid"
  | "team_slug_invalid"
  | "team_external_id_invalid"
  | "team_data_invalid"
  | "team_organization_unknown"
  | "team_update_empty"
  | "team_archived"
  | "team_not_archived"
  | "team_version_conflict"
  | "team_invalid"
  | "team_parent_invalid"
  | "team_cycle"
  | "team_too_deep"
  | "team_has_children"
  | "team_membership_not_found"
  | "team_membership_exists"
  | "team_membership_invalid"
  | "team_membership_transition_invalid"
  | "team_accept_forbidden"
  | "team_forbidden"
  | "team_authorization_required"
  | "team_membership_version_conflict"
  | "team_member_unknown"
  | "team_role_invalid"
  | "team_role_owner_protected";

export class TeamError extends UnioraError {
  constructor(message: string, code: TeamErrorCode = "team_invalid") {
    super(message, code);
    this.name = "TeamError";
  }
}

export const MAX_TEAM_NAME_LENGTH = 255;
export const MAX_TEAM_EXTERNAL_ID_LENGTH = 200;
export const MAX_TEAM_DATA_BYTES = 16 * 1024;
export const MAX_TEAM_REASON_LENGTH = 500;
export const MAX_TEAM_MEMBER_ROLES = 50;
/** Teams one member can belong to for policy evaluation; a member in more is `subject.teamIds` unavailable (fail closed). */
export const MAX_SUBJECT_TEAMS = 500;
/** Levels in a team tree, counting the top-level team as 1. */
export const MAX_TEAM_DEPTH = 8;

/**
 * What a backend learned about the place a team is about to take in the tree; `assertTeamPlacement` turns it into the same
 * stable error everywhere. `parent` is `null` when the parent does not exist in the organization.
 */
export interface TeamPlacementFacts {
  selfId: string | null;
  parentId: string;
  parent: { status: TeamStatus; depth: number } | null;
  /** The team being moved is the parent itself, or one of the parent's ancestors (so the move would close a loop). */
  loop: boolean;
  /** Levels below the team being moved (0 for a leaf; always 0 for a team that is being created). */
  subtreeHeight: number;
}

export function assertTeamPlacement(facts: TeamPlacementFacts): void {
  if (!facts.parent) throw new TeamError(`Parent team not found: ${facts.parentId}`, "team_parent_invalid");
  if (facts.loop) throw new TeamError("A team cannot be placed under itself or under one of its own sub-teams.", "team_cycle");
  if (facts.parent.status !== "active") throw new TeamError("An archived team cannot get sub-teams; restore it first.", "team_parent_invalid");
  if (facts.parent.depth + 1 + facts.subtreeHeight > MAX_TEAM_DEPTH) {
    throw new TeamError(`Teams can be nested at most ${MAX_TEAM_DEPTH} levels deep.`, "team_too_deep");
  }
}

export interface CreateTeamInput {
  /** Proof that the change is authorized (see `TeamAuthorization`). */
  authorization: TeamAuthorization;
  id: string;
  /** The organization the team belongs to, forever. */
  organizationId: string;
  name: string;
  /** Derived from the name when omitted. */
  slug?: string;
  externalId?: string;
  /** An ACTIVE team of the same organization to nest this one under. Omit for a top-level team. */
  parentId?: string;
  metadata?: TeamData;
  settings?: TeamData;
  now?: Date;
}

export interface UpdateTeamInput {
  authorization: TeamAuthorization;
  name?: string;
  slug?: string;
  /** A string sets it; `null` clears it. */
  externalId?: string | null;
  /** Moves the team (with everything under it) below another ACTIVE team of the organization; `null` makes it top-level. */
  parentId?: string | null;
  /** Replaces the whole metadata object. */
  metadata?: TeamData;
  /** Replaces the whole settings object. */
  settings?: TeamData;
  expectedVersion?: number;
}

export interface ArchiveTeamInput {
  authorization: TeamAuthorization;
  actor: Identity;
  reason?: string;
  expectedVersion?: number;
}

export interface RestoreTeamInput {
  authorization: TeamAuthorization;
  actor: Identity;
  expectedVersion?: number;
}

export interface SearchTeamsOptions {
  /** Teams are always listed within ONE organization. */
  organizationId: string;
  status?: TeamStatus;
  /** Case-insensitive substring of the name or the slug. */
  query?: string;
  externalId?: string;
  /** The direct sub-teams of this team; `null` for the top-level teams; omitted for all of them. */
  parentId?: string | null;
  limit?: number;
  /** Keyset cursor: the `id` of the last team of the previous page; results are ordered by `id`. */
  after?: string;
}

/**
 * Every method that takes a team id also takes the organization id and treats a team of ANOTHER organization exactly
 * like a team that does not exist: a bare `teamId` is never enough (cross-tenant isolation).
 */
export interface TeamRepository {
  /** Rejects an unknown organization (`team_organization_unknown`), a repeated id/slug/externalId, an invalid name, slug or data. */
  create(input: CreateTeamInput): Promise<Team>;
  findById(organizationId: string, id: string): Promise<Team | null>;
  findBySlug(organizationId: string, slug: string): Promise<Team | null>;
  findByExternalId(organizationId: string, externalId: string): Promise<Team | null>;
  search(options: SearchTeamsOptions): Promise<Team[]>;
  count(options: Omit<SearchTeamsOptions, "limit" | "after">): Promise<number>;
  /** The chain above a team, top-level team first, the team itself excluded. Empty for a top-level team. */
  ancestors(organizationId: string, id: string): Promise<Team[]>;
  /** Every team below this one, at any depth, ordered by `id`. */
  descendants(organizationId: string, id: string): Promise<Team[]>;
  /**
   * Changes an ACTIVE team (`team_archived` otherwise). A call that changes nothing keeps the version. Empty input: `team_update_empty`. A new `parentId` is checked (`team_parent_invalid`, `team_cycle`, `team_too_deep`). */
  update(organizationId: string, id: string, input: UpdateTeamInput): Promise<Team>;
  /** Idempotent. An archived team keeps its members and history but cannot be changed or joined until it is restored. A team that still has active sub-teams cannot be archived (`team_has_children`). */
  archive(organizationId: string, id: string, input: ArchiveTeamInput): Promise<Team>;
  /** Idempotent. Under an archived parent it fails (`team_parent_invalid`): restore the parent first. */
  restore(organizationId: string, id: string, input: RestoreTeamInput): Promise<Team>;
  /** Permanently removes an ARCHIVED team and its team memberships (`team_not_archived` otherwise), and only one without sub-teams (`team_has_children`: move or delete them first). The audit trail stays. */
  delete(organizationId: string, id: string, input: { authorization: TeamAuthorization }): Promise<void>;
}

export interface AddTeamMemberInput {
  authorization: TeamAuthorization;
  id: string;
  organizationId: string;
  teamId: string;
  /** The organization membership to add; it must belong to `organizationId`. */
  membershipId: string;
  /** `pending` for an invitation that must be accepted, `active` (default) to add directly. */
  status?: "pending" | "active";
  responsibility?: TeamResponsibility;
  /** Roles of the same organization, never the Owner role. */
  roleIds?: string[];
  invitedBy?: Identity;
  now?: Date;
}

export interface SearchTeamMembersOptions {
  organizationId: string;
  teamId?: string;
  membershipId?: string;
  /** Every team membership of one identity in the organization. */
  identity?: Identity;
  status?: TeamMemberStatus;
  responsibility?: TeamResponsibility;
  limit?: number;
  /** Keyset cursor: the `id` of the last row of the previous page; results are ordered by `id`. */
  after?: string;
}

export interface TeamMemberChangeOptions {
  authorization: TeamAuthorization;
  /** Apply only if the team membership is still at this `version`; otherwise `team_membership_version_conflict`. */
  expectedVersion?: number;
}

export interface SetTeamMemberStatusInput extends TeamMemberChangeOptions {
  actor: Identity;
  reason?: string;
}

/**
 * Team memberships. Like `RoleRepository`/`MembershipRepository` these primitives perform no authorization of their
 * own: the host decides who may invite, remove or promote (typically with `engine.can`) before calling them.
 */
export interface TeamMembershipRepository {
  /**
   * Adds an organization member to an ACTIVE team. A previously `removed` row of the same pair is reused (its history
   * stays); any other existing row is `team_membership_exists`. Rejects a membership of another organization
   * (`team_member_unknown`), an archived team (`team_archived`) and roles that are unknown, foreign or the Owner role.
   */
  add(input: AddTeamMemberInput): Promise<TeamMembership>;
  findById(organizationId: string, id: string): Promise<TeamMembership | null>;
  find(organizationId: string, teamId: string, membershipId: string): Promise<TeamMembership | null>;
  /**
   * The ids of the ACTIVE teams this organization membership is an ACTIVE member of (a pending, suspended or removed team
   * membership, or an archived team, does not count), ordered by id, at most `limit` (default 1000). Ask for one more than you
   * can handle to know whether the list was cut. One indexed query: this is what the policy engine reads as `subject.teamIds`.
   */
  activeTeamIds(organizationId: string, membershipId: string, options?: { limit?: number }): Promise<string[]>;
  search(options: SearchTeamMembersOptions): Promise<TeamMembership[]>;
  count(options: Omit<SearchTeamMembersOptions, "limit" | "after">): Promise<number>;
  /**
   * Moves a membership along active → suspended → removed (and suspended → active), or removes a pending one; accepting an invitation is `accept`, by the invited person only. Idempotent for the status it
   * already has; any other jump is `team_membership_transition_invalid`. Bring a removed one back with `add`.
   */
  setStatus(organizationId: string, id: string, status: TeamMemberStatus, input: SetTeamMemberStatusInput): Promise<TeamMembership>;
  /**
   * The invited person accepts their own invitation: `pending → active`, and only when `input.actor` is exactly the identity
   * of the organization membership the invitation is for (`team_accept_forbidden` otherwise, so nobody can accept, or be
   * made to accept, on someone else's behalf). Idempotent for an already active membership of that person; any other status
   * is `team_membership_transition_invalid`. `setStatus` cannot do this move on purpose.
   */
  accept(organizationId: string, id: string, input: { actor: Identity } & TeamMemberChangeOptions): Promise<TeamMembership>;
  /** Idempotent. */
  setResponsibility(organizationId: string, id: string, responsibility: TeamResponsibility, options: TeamMemberChangeOptions): Promise<TeamMembership>;
  /** Idempotent. Same role rules as `add`. */
  assignRole(organizationId: string, id: string, roleId: string, options: TeamMemberChangeOptions): Promise<TeamMembership>;
  /** Idempotent. */
  unassignRole(organizationId: string, id: string, roleId: string, options: TeamMemberChangeOptions): Promise<TeamMembership>;
}

const TRANSITIONS: Record<TeamMemberStatus, readonly TeamMemberStatus[]> = {
  pending: ["removed"],
  active: ["suspended", "removed"],
  suspended: ["active", "removed"],
  removed: [],
};

/** Whether `from → to` is a legal move of `setStatus` (the same status is a no-op, handled by the caller). */
export function isTeamMemberTransitionAllowed(from: TeamMemberStatus, to: TeamMemberStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTeamMemberStatus(value: unknown): TeamMemberStatus {
  if (typeof value !== "string" || !(TEAM_MEMBER_STATUSES as readonly string[]).includes(value)) {
    throw new TeamError(`A team member status must be one of: ${TEAM_MEMBER_STATUSES.join(", ")}.`, "team_membership_invalid");
  }
  return value as TeamMemberStatus;
}

export function assertTeamResponsibility(value: unknown): TeamResponsibility {
  if (typeof value !== "string" || !(TEAM_RESPONSIBILITIES as readonly string[]).includes(value)) {
    throw new TeamError(`A team responsibility must be one of: ${TEAM_RESPONSIBILITIES.join(", ")}.`, "team_membership_invalid");
  }
  return value as TeamResponsibility;
}

export function assertTeamId(value: unknown, what = "team id"): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new TeamError(`The ${what} must be a non-empty text of at most 200 characters.`);
  }
  return value;
}

export function sanitizeTeamName(name: unknown): string {
  if (typeof name !== "string") throw new TeamError("Team name must be a string.", "team_name_invalid");
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed === "") throw new TeamError("Team name cannot be empty.", "team_name_invalid");
  if (trimmed.length > MAX_TEAM_NAME_LENGTH) {
    throw new TeamError(`Team name cannot exceed ${MAX_TEAM_NAME_LENGTH} characters.`, "team_name_invalid");
  }
  return trimmed;
}

/** An explicit slug as-is (validated), or one derived from the name. Uniqueness within the organization is the storage's job. */
export function resolveTeamSlug(name: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || explicit === "" || explicit.length > MAX_SLUG_LENGTH || !matchesSlugPattern(explicit)) {
      throw new TeamError(
        'Team slug must be lowercase alphanumeric characters separated by single hyphens (e.g. "barcelona-sales"), at most 63 characters.',
        "team_slug_invalid",
      );
    }
    return explicit;
  }
  const derived = deriveSlug(name);
  if (derived === "") throw new TeamError("Could not derive a URL-safe slug from this team name; pass an explicit `slug`.", "team_slug_invalid");
  return derived;
}

export function sanitizeTeamExternalId(value: unknown): string {
  if (typeof value !== "string") throw new TeamError("The external id must be a string.", "team_external_id_invalid");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_TEAM_EXTERNAL_ID_LENGTH) {
    throw new TeamError(`The external id must be 1 to ${MAX_TEAM_EXTERNAL_ID_LENGTH} characters.`, "team_external_id_invalid");
  }
  return trimmed;
}

const MAX_DATA_DEPTH = 8;

function isPlainJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_DATA_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(value as Record<string, unknown>).every(([key, item]) => key !== "__proto__" && isPlainJson(item, depth + 1));
  }
  return false;
}

/**
 * Validates a `metadata` or `settings` object: plain JSON (no dates, functions, class instances or cycles), nested at
 * most 8 levels, at most 16 KB serialized. Returns a deep copy, so the caller can't mutate the stored value afterwards.
 */
export function sanitizeTeamData(value: unknown, what: "metadata" | "settings"): TeamData {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isPlainJson(value, 0)) {
    throw new TeamError(`Team ${what} must be a plain JSON object (nested at most ${MAX_DATA_DEPTH} levels).`, "team_data_invalid");
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_TEAM_DATA_BYTES) {
    throw new TeamError(`Team ${what} cannot exceed ${MAX_TEAM_DATA_BYTES} bytes of JSON.`, "team_data_invalid");
  }
  return JSON.parse(json) as TeamData;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Whether two `metadata`/`settings` objects hold the same data, whatever the order of their keys (a database may reorder them). */
export function sameTeamData(a: TeamData, b: TeamData): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function sanitizeTeamReason(reason: string | undefined): string | undefined {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_TEAM_REASON_LENGTH);
}

/** Validates a creation input the same way in every backend and returns the normalised pieces. */
export function assertValidCreateTeam(input: CreateTeamInput): {
  name: string;
  slug: string;
  externalId?: string;
  parentId?: string;
  metadata: TeamData;
  settings: TeamData;
  now: Date;
} {
  assertTeamId(input.id);
  assertTeamId(input.organizationId, "organization id");
  const name = sanitizeTeamName(input.name);
  if (input.parentId !== undefined) assertTeamId(input.parentId, "parent team id");
  return {
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    name,
    slug: resolveTeamSlug(name, input.slug),
    externalId: input.externalId === undefined ? undefined : sanitizeTeamExternalId(input.externalId),
    metadata: sanitizeTeamData(input.metadata ?? {}, "metadata"),
    settings: sanitizeTeamData(input.settings ?? {}, "settings"),
    now: input.now ?? new Date(),
  };
}

/** The pieces of an `update` after validation; `undefined` fields are left alone (`externalId: null` clears it). */
export interface ValidTeamUpdate {
  name?: string;
  slug?: string;
  externalId?: string | null;
  parentId?: string | null;
  metadata?: TeamData;
  settings?: TeamData;
}

export function assertValidUpdateTeam(input: UpdateTeamInput): ValidTeamUpdate {
  const update: ValidTeamUpdate = {};
  if (input.name !== undefined) update.name = sanitizeTeamName(input.name);
  if (input.slug !== undefined) update.slug = resolveTeamSlug("", input.slug);
  if (input.externalId !== undefined) update.externalId = input.externalId === null ? null : sanitizeTeamExternalId(input.externalId);
  if (input.parentId !== undefined) {
    if (input.parentId !== null) assertTeamId(input.parentId, "parent team id");
    update.parentId = input.parentId;
  }
  if (input.metadata !== undefined) update.metadata = sanitizeTeamData(input.metadata, "metadata");
  if (input.settings !== undefined) update.settings = sanitizeTeamData(input.settings, "settings");
  if (Object.keys(update).length === 0) throw new TeamError("Nothing to update.", "team_update_empty");
  return update;
}

export function assertValidAddTeamMember(input: AddTeamMemberInput): {
  status: "pending" | "active";
  responsibility: TeamResponsibility;
  roleIds: string[];
  now: Date;
} {
  assertTeamId(input.id);
  assertTeamId(input.organizationId, "organization id");
  assertTeamId(input.teamId);
  assertTeamId(input.membershipId, "membership id");
  const status = input.status ?? "active";
  if (status !== "pending" && status !== "active") {
    throw new TeamError('A team member is added as "pending" or "active".', "team_membership_invalid");
  }
  const roleIds = [...new Set(input.roleIds ?? [])];
  if (roleIds.length > MAX_TEAM_MEMBER_ROLES) {
    throw new TeamError(`A team member holds at most ${MAX_TEAM_MEMBER_ROLES} roles.`, "team_role_invalid");
  }
  for (const roleId of roleIds) assertTeamId(roleId, "role id");
  return {
    status,
    responsibility: input.responsibility === undefined ? "member" : assertTeamResponsibility(input.responsibility),
    roleIds,
    now: input.now ?? new Date(),
  };
}

/** Whether the team membership counts as belonging to the team right now (and so gives context to the engine). */
export function isTeamMembershipActive(membership: Pick<TeamMembership, "status">): boolean {
  return membership.status === "active";
}
