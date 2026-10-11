import { UnioraError, inferErrorCode } from "../shared/errors.js";
import type { MembershipErrorCode } from "../shared/errors.js";
import type { Identity } from "../identity/types.js";
import type { AccessAuthorization, AccessWriteOptions } from "../access/authorization.js";
import type { RoleSummary } from "../role/repository.js";
import type { Membership, MembershipStatus } from "./types.js";

export class MembershipError extends UnioraError {
  constructor(message: string, code?: MembershipErrorCode) {
    super(message, code ?? inferErrorCode("membership", message));
    this.name = "MembershipError";
  }
}

export interface CreateMembershipInput {
  id: string;
  organizationId: string;
  identity: Identity;
  /**
   * Rejected (`MembershipError`) if any id doesn't exist or belongs to a
   * DIFFERENT organization than `organizationId` — same guard as
   * `MembershipRepository.assignRole` (docs/security-pentest-2026-09-24.md
   * Hallazgo 2).
   */
  roleIds?: string[];
  /** Who invited this member, kept on the membership ("invited by" in a members screen). */
  invitedBy?: Identity;
  /** Overrides "now" for `createdAt` — only for importing existing members. */
  createdAt?: Date;
  /** Needed by a guarded storage when `roleIds` is not empty (see `createGuardedStorage`); ignored otherwise. */
  authorization?: AccessAuthorization;
}

export interface SearchMembershipsOptions {
  /** Restrict to one organization. Omit to search across every organization (admin views only). */
  organizationId?: string;
  limit?: number;
  /** Keyset cursor — the `id` of the last membership of the previous page. */
  after?: string;
  /** Case-insensitive substring match against the identity's `subject` or `provider`. */
  query?: string;
  /** Exact `(provider, subject)` match — every membership of one identity, across organizations. */
  identity?: Identity;
  /** Only memberships with this status. Omit for both. */
  status?: MembershipStatus;
}

export interface BlockMembershipInput {
  /** Who is blocking. Required: a block is always attributable. */
  actor: Identity;
  /** Free text, trimmed and capped at 500 characters. */
  reason?: string;
  /** Apply only if the membership is still at this `version`; otherwise `membership_version_conflict` and nothing changes. */
  expectedVersion?: number;
  /** Needed by a guarded storage (see `createGuardedStorage`); ignored otherwise. */
  authorization?: AccessAuthorization;
}

export interface SuspendMembershipInput extends BlockMembershipInput {
  /** The member is `active` again by themselves once this instant passes. A valid date in the future (`membership_block_until_invalid`). */
  until: Date;
}

export interface UnblockMembershipInput {
  actor: Identity;
  /** Apply only if the membership is still at this `version`; otherwise `membership_version_conflict` and nothing changes. */
  expectedVersion?: number;
  /** Needed by a guarded storage (see `createGuardedStorage`); ignored otherwise. */
  authorization?: AccessAuthorization;
}

export interface MembershipVersionOptions extends AccessWriteOptions {
  /** Apply only if the membership is still at this `version` (see `Membership.version`); otherwise `membership_version_conflict`. */
  expectedVersion?: number;
}

/**
 * A membership as listed to a human: identity, how many roles it holds, and
 * only a short preview of them. A member can hold hundreds of roles, so a
 * listing must never carry them all — the rest is fetched on demand
 * (`RoleRepository.search({ heldBy })`).
 */
export interface MembershipListing {
  id: string;
  organizationId: string;
  identity: Identity;
  roleCount: number;
  status: MembershipStatus;
  createdAt: Date;
  invitedBy?: Identity;
  lastActiveAt?: Date;
  /** Up to `rolesPerMember` roles — the Owner role first, then alphabetical. */
  roles: RoleSummary[];
}

export interface MembershipRepository {
  create(input: CreateMembershipInput): Promise<Membership>;
  findByIdentity(organizationId: string, identity: Identity): Promise<Membership | null>;
  listByOrganization(organizationId: string): Promise<Membership[]>;
  findById(id: string): Promise<Membership | null>;
  /**
   * Paginated, optionally filtered listing (keyset on `id`, never `offset`),
   * scoped to one organization or across all of them. Use this — not
   * `listByOrganization` — to render members to a human.
   */
  search(options?: SearchMembershipsOptions): Promise<Membership[]>;
  /**
   * Same paging/filters as `search`, but each row carries a bounded preview
   * of its roles plus the total role count (never every role id).
   */
  searchListing(options: SearchMembershipsOptions & { rolesPerMember: number }): Promise<MembershipListing[]>;
  /**
   * Count of memberships (optionally within one organization / matching `query`) — never loads rows.
   * With `limit`, the answer is at most that many — it stops counting there, so a filter matching millions of rows costs a page of work.
   */
  count(options?: { organizationId?: string; query?: string; identity?: Identity; status?: MembershipStatus; limit?: number }): Promise<number>;
  /**
   * How many members currently hold each of the given roles, in one call.
   * Every requested id is present (`0` when none).
   */
  countByRole(roleIds: string[]): Promise<Record<string, number>>;
  /**
   * Members per organization for a batch of organization ids, in one call.
   * Every requested id is present (`0` when it has none). With `limit`, each count stops there ("at least this
   * many"), so an organization with millions of rows costs `limit` index entries.
   */
  countByOrganization(organizationIds: string[], options?: { limit?: number }): Promise<Record<string, number>>;
  /**
   * Assigns a REGULAR (non-Owner) role. Idempotent (no-op if already
   * assigned). Rejects (`MembershipError`) if `membershipId`/`roleId` don't
   * exist, if `roleId` belongs to a DIFFERENT organization than the
   * membership (uniora-security-engineering §17/§20;
   * docs/security-pentest-2026-09-24.md Hallazgo 2), **or if `roleId` is the
   * organization's protected Owner role** — use `assignOwnerRole` for that,
   * a deliberately separate, unmistakably-named method (same "explicit >
   * implicit" principle as `RoleRepository.createOwnerRole` being separate
   * from `create`). Without this split, a host that authorizes this call
   * with one generic permission (e.g. `roles.assign`, meant for ordinary
   * role management) would unknowingly also let that same permission grant
   * full Owner access — a real privilege-escalation chain found and closed
   * the same day it was designed (docs/security-pentest-2026-09-24.md
   * Hallazgo 7).
   *
   * **This method performs no authorization of its own** — it does not check
   * that the caller is allowed to grant `roleId` (e.g. holds a
   * `roles.assign`-equivalent permission). The host application must
   * authorize that decision itself (typically via `engine.can()`) before
   * calling this primitive — same trust boundary as
   * `IdentityLinkRepository.link()` (uniora-security-engineering §71-72
   * "Unsafe APIs"; docs/security-pentest-2026-09-24.md Hallazgo 3).
   */
  assignRole(membershipId: string, roleId: string, options?: MembershipVersionOptions): Promise<void>;
  /**
   * The ONLY way to grant the organization's protected Owner role to an
   * existing membership — see `assignRole` for why this is a separate
   * method rather than a special case of it. Idempotent. Rejects
   * (`MembershipError`) if `membershipId` doesn't exist, or if `roleId`
   * isn't actually the Owner role of that membership's organization (wrong
   * organization, or a regular role — use `assignRole` for those).
   *
   * **Performs no authorization of its own**, same trust boundary as
   * `assignRole` — but naming this call explicitly gives the host a single,
   * greppable place to attach a strictly stronger check (e.g.
   * `organization.transfer_ownership`) than whatever gates ordinary role
   * assignment.
   */
  assignOwnerRole(membershipId: string, roleId: string, options?: AccessWriteOptions): Promise<void>;
  /**
   * Unassigns a REGULAR (non-Owner) role. Idempotent (no-op if not
   * assigned). Rejects (`MembershipError`) if `roleId` is the organization's
   * protected Owner role — use `unassignOwnerRole` for that (same split, and
   * the same reasoning, as `assignRole`/`assignOwnerRole` above).
   */
  unassignRole(membershipId: string, roleId: string, options?: MembershipVersionOptions): Promise<void>;
  /**
   * The ONLY way to remove the organization's protected Owner role from a
   * membership. Idempotent. Rejects (`MembershipError`) if `roleId` isn't
   * actually the Owner role (use `unassignRole` for those), or if
   * `membershipId` is the only membership currently holding it — every
   * organization must always keep at least one Owner
   * (uniora-security-engineering §11 Owner Protection). Assigning the Owner
   * role to more than one membership is valid and unassigning any of the
   * extra ones is fine; only the last one is protected.
   */
  unassignOwnerRole(membershipId: string, roleId: string, options?: AccessWriteOptions): Promise<void>;
  /**
   * Blocks a member without removing them: the engine denies a blocked member everything (`can`,
   * `access.check`, snapshots) while roles, history and audit trail stay. Idempotent — blocking an
   * already-blocked member changes nothing (keeps the original actor, reason and date; `unblock` first
   * to change them). Blocking a SUSPENDED member turns the suspension into an indefinite block (new actor, reason and
   * date; the member does not come back by themselves): a block never ends sooner than the suspension it replaces.
   * A suspension that already ended counts as not blocked. Rejects (`MembershipError`) if the
   * membership doesn't exist (`membership_not_found`), or if it is an Owner and no OTHER active Owner would
   * remain (`last_owner`) — an organization must always keep an Owner who can still act.
   *
   * **Performs no authorization of its own** — authorize who may block (e.g. `members.block`) in the host,
   * like `assignRole`.
   */
  block(membershipId: string, input: BlockMembershipInput): Promise<Membership>;
  /**
   * Same as `block`, but the member is denied only until `input.until` and then is `active` again by themselves:
   * status `suspended` meanwhile (see `MembershipStatus`). The last active Owner can't be suspended (`last_owner`).
   * Suspending a member who is already blocked or suspended changes nothing (never shortens or extends: `unblock`
   * first to change it). Same trust boundary as `block` (authorize it in the host, e.g. `members.suspend`).
   */
  suspend(membershipId: string, input: SuspendMembershipInput): Promise<Membership>;
  /** Lifts a block or a suspension. Idempotent. Rejects (`membership_not_found`) for an unknown membership. */
  unblock(membershipId: string, input: UnblockMembershipInput): Promise<Membership>;
  /**
   * Reports that the member was active at `at` (default: now) — for a "last seen" column. Only ever moves
   * `lastActiveAt` forward, never touches `updatedAt`, and is a no-op for an unknown membership.
   */
  recordActivity(membershipId: string, at?: Date): Promise<void>;
  /**
   * Rejects if the membership is not found, or if it holds the
   * organization's Owner role and is the only membership holding it.
   */
  delete(membershipId: string, options?: AccessWriteOptions): Promise<void>;
}

/** The latest representable end of a suspension: the last instant of year 9999 (SQLite compares ISO-8601 text, which only sorts right for four-digit years). */
export const MAX_BLOCK_UNTIL = new Date("9999-12-31T23:59:59.999Z");

/** Validates the end of a timed suspension: a valid `Date` strictly after `now` and no later than `MAX_BLOCK_UNTIL`. Returns it, or `undefined` when none. */
export function assertBlockUntil(until: Date | undefined, now: Date = new Date()): Date | undefined {
  if (until === undefined) return undefined;
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
    throw new MembershipError("The end of a suspension must be a valid date.", "membership_block_until_invalid");
  }
  if (until.getTime() <= now.getTime()) {
    throw new MembershipError("The end of a suspension must be in the future.", "membership_block_until_invalid");
  }
  if (until.getTime() > MAX_BLOCK_UNTIL.getTime()) {
    throw new MembershipError("The end of a suspension can't be after the year 9999; use block() for an indefinite one.", "membership_block_until_invalid");
  }
  return new Date(until.getTime());
}

/** Trims and caps the free-text reason of a block; `undefined` when empty. */
export function sanitizeBlockReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}
