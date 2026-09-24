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
  assignRole(membershipId: string, roleId: string): Promise<void>;
  /**
   * Idempotent (no-op if not assigned). Rejects (`MembershipError`) if
   * `roleId` is the organization's protected Owner role and this is the
   * only membership currently holding it — every organization must always
   * keep at least one Owner (uniora-security-engineering §11 Owner
   * Protection). Assigning the Owner role to more than one membership is
   * allowed and unassigning any of the extra ones is fine; only the last
   * one is protected.
   */
  unassignRole(membershipId: string, roleId: string): Promise<void>;
  /**
   * Rejects if the membership is not found, or if it holds the
   * organization's Owner role and is the only membership holding it.
   */
  delete(membershipId: string): Promise<void>;
}
