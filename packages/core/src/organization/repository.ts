import type { Identity } from "../identity/types.js";
import type { Organization, OrganizationStatus } from "./types.js";

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

export interface UpdateOrganizationInput {
  /** New display name, sanitized like on `create`. */
  name?: string;
  /**
   * New URL handle. Changing it breaks every link that used the old one, so do it on purpose; it must be well formed
   * and not taken (`OrganizationError`: `organization_slug_invalid`, `organization_slug_taken`).
   */
  slug?: string;
  /**
   * Apply the change only if the organization is still at this `version` (see `Organization.version`); otherwise it is
   * refused with `organization_version_conflict` and nothing changes. Omitted: last write wins, as before.
   */
  expectedVersion?: number;
}

export interface SetOrganizationStatusInput {
  status: OrganizationStatus;
  /** Who is changing it. Required: the change is recorded with the organization and in the audit log. */
  actor: Identity;
  /** Why (at most 500 characters), shown wherever the status is shown. */
  reason?: string;
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
  /** Only organizations in this status (or any of these). Omitted matches every status. */
  status?: OrganizationStatus | OrganizationStatus[];
  /**
   * Only organizations where this feature is (or, with `enabled: false`, is not) EFFECTIVELY on: their override, else
   * the feature's default, and every parent on. An unregistered key is on nowhere. Combines with `status` and `query`.
   */
  feature?: { key: string; enabled?: boolean };
}

export interface OrganizationRepository {
  create(input: CreateOrganizationInput): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
  /**
   * Changes the display `name` of an existing organization and returns the
   * updated record, or `null` if no organization has that id. The name is
   * sanitized like on `create` (`OrganizationError` if empty/oversized).
   * The `slug` is deliberately left untouched — it is a URL handle that
   * other systems may have stored, so renaming never breaks existing links.
   * Authorization is the caller's job (the protected Owner role passes
   * every permission check).
   */
  rename(id: string, name: string): Promise<Organization | null>;
  /**
   * Changes `name` and/or `slug` in one step and returns the updated record, or `null` if there is no such
   * organization. Passing neither is an error (`organization_update_empty`). Authorization is the caller's job.
   */
  update(id: string, input: UpdateOrganizationInput): Promise<Organization | null>;
  /**
   * Moves the organization to `active`, `suspended` or `archived` and records who did it and why (`statusChange`).
   * While it is not `active` the authorization engine (`can`, `access.check`, snapshots) and the SQL functions for RLS
   * deny everyone in it, Owner included; the data stays untouched, so setting it back to `active` restores everything.
   * Setting the status it already has changes nothing. Returns `null` for an unknown organization. There is no
   * hard delete on purpose: the audit trail of an organization must outlive it (see `guides/`).
   * Authorization is the caller's job.
   */
  setStatus(id: string, input: SetOrganizationStatusInput): Promise<Organization | null>;
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
  /**
   * Total organizations matching `query` (or all, if omitted) — for result counts/badges without loading every row.
   * With `limit`, the answer is at most that many — it stops counting there, so a filter matching millions of rows costs a page of work.
   */
  count(options?: Pick<SearchOrganizationsOptions, "query" | "status" | "feature"> & { limit?: number }): Promise<number>;
}
