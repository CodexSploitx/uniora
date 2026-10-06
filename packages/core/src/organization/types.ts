import type { Identity } from "../identity/types.js";

/**
 * `active` is normal operation. `suspended` (e.g. unpaid, under review) and `archived` (closed, kept for the record)
 * both make the authorization engine deny EVERYTHING in the organization, Owner included, until it is `active` again.
 * Nothing is deleted: the audit trail of an organization must outlive it.
 */
export const ORGANIZATION_STATUSES = ["active", "suspended", "archived"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** Who moved an organization to its current status, when and why. Absent for an organization that was never changed. */
export interface OrganizationStatusChange {
  at: Date;
  by: Identity;
  reason?: string;
}

export interface Organization {
  readonly id: string;
  /** URL-safe handle, unique across every organization. See `resolveOrganizationSlug`. */
  slug: string;
  name: string;
  readonly createdAt: Date;
  status: OrganizationStatus;
  /** The last status change (see `OrganizationRepository.setStatus`). */
  statusChange?: OrganizationStatusChange;
}
