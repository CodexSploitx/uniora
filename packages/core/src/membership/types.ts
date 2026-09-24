import type { Identity } from "../identity/types.js";

/**
 * The relation between an Identity and an Organization (docs/PROYECT.md §5).
 * A single identity can hold multiple memberships across organizations.
 */
export interface Membership {
  readonly id: string;
  readonly organizationId: string;
  readonly identity: Identity;
  roleIds: string[];
}
