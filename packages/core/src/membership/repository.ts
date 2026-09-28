import type { Identity } from "../identity/types.js";
import type { RoleSummary } from "../role/repository.js";
import type { Membership } from "./types.js";

export class MembershipError extends Error {
  constructor(message: string) {
    super(message);
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
  /** Count of memberships (optionally within one organization / matching `query`) — never loads rows. */
  count(options?: { organizationId?: string; query?: string; identity?: Identity }): Promise<number>;
  /**
   * How many members currently hold each of the given roles, in one call.
   * Every requested id is present (`0` when none).
   */
  countByRole(roleIds: string[]): Promise<Record<string, number>>;
  /**
   * Members per organization for a batch of organization ids, in one call.
   * Every requested id is present (`0` when it has none).
   */
  countByOrganization(organizationIds: string[]): Promise<Record<string, number>>;
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
  assignRole(membershipId: string, roleId: string): Promise<void>;
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
  assignOwnerRole(membershipId: string, roleId: string): Promise<void>;
  /**
   * Unassigns a REGULAR (non-Owner) role. Idempotent (no-op if not
   * assigned). Rejects (`MembershipError`) if `roleId` is the organization's
   * protected Owner role — use `unassignOwnerRole` for that (same split, and
   * the same reasoning, as `assignRole`/`assignOwnerRole` above).
   */
  unassignRole(membershipId: string, roleId: string): Promise<void>;
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
  unassignOwnerRole(membershipId: string, roleId: string): Promise<void>;
  /**
   * Rejects if the membership is not found, or if it holds the
   * organization's Owner role and is the only membership holding it.
   */
  delete(membershipId: string): Promise<void>;
}
