import type { Organization } from "./types.js";

export interface CreateOrganizationInput {
  id: string;
  name: string;
  /**
   * URL-safe handle, unique across every organization. Optional — derived
   * from `name` when omitted (see `resolveOrganizationSlug`). Rejected
   * (`OrganizationError`) if malformed, or if it collides with an
   * existing organization's slug.
   */
  slug?: string;
}

export interface OrganizationCursor {
  createdAt: Date;
  id: string;
}

export interface SearchOrganizationsOptions {
  limit?: number;
  /** Keyset cursor — only organizations strictly after this position are returned. */
  after?: OrganizationCursor;
  /** Case-insensitive substring match against `name` or `slug`. Empty/omitted matches everything. */
  query?: string;
}

export interface OrganizationRepository {
  create(input: CreateOrganizationInput): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
  /** Batch lookup — unknown ids are simply absent from the result (no error, no ordering guarantee). */
  findByIds(ids: string[]): Promise<Organization[]>;
  /**
   * Every organization, unpaginated — for internal cross-organization
   * aggregation (Overview totals, the Permissions/Features catalog pages).
   * Never use this to render a list of organizations to a human; use
   * `search` instead, which pages and can filter by text.
   */
  list(): Promise<Organization[]>;
  /**
   * Paginated, optionally filtered listing for UIs that display
   * organizations directly (e.g. an admin "Organizations" page). Ordered
   * oldest-first (`createdAt asc, id asc`), same order as `list()`, paged
   * with a keyset cursor (`after`) rather than `offset` — organizations
   * keep being created underneath any given page, so an offset could skip
   * or repeat rows across pages.
   */
  search(options?: SearchOrganizationsOptions): Promise<Organization[]>;
  /** Total organizations matching `query` (or all, if omitted) — for result counts/badges without loading every row. */
  count(options?: { query?: string }): Promise<number>;
}
