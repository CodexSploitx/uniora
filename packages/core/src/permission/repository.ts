import type { Permission } from "./types.js";

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export interface RegisterPermissionInput {
  /**
   * A lowercase, dot-namespaced "resource.action" identifier (e.g.
   * "vehicles.delete") — always explicit, **never** derived from `name`
   * (see `assertValidPermissionKey`).
   */
  key: string;
  name?: string;
  description?: string;
}

export interface SearchPermissionsOptions {
  limit?: number;
  /** Keyset cursor — only permissions whose `key` sorts strictly after this one are returned. */
  after?: string;
  /** Case-insensitive substring match against `key` or `name`. Empty/omitted matches everything. */
  query?: string;
  /** Only permissions currently granted to this role. */
  grantedToRole?: string;
  /** Only permissions the membership holds through ANY of its roles (its effective permissions; the Owner role's flag-based full access is not a list and is not included). */
  grantedToMember?: string;
}

export interface PermissionRepository {
  /**
   * Creates or updates a catalog entry — idempotent upsert, same contract
   * as `FeatureRepository.register`: re-registering the same `key` with a
   * new `name`/`description` updates it, it never throws on an existing
   * key. `key` is validated (`assertValidPermissionKey`, fail-closed —
   * rejects, never silently normalizes) and `name` is sanitized
   * (`sanitizePermissionName`) when given.
   */
  register(input: RegisterPermissionInput): Promise<Permission>;
  findByKey(key: string): Promise<Permission | null>;
  /**
   * Every permission, unpaginated — only for internal aggregation (e.g. the
   * roles × permissions matrix of one organization). Never use it to render
   * the catalog to a human; use `search`, which pages and can filter.
   */
  list(): Promise<Permission[]>;
  /**
   * Paginated, optionally filtered catalog listing for UIs. Ordered by `key`
   * ascending and paged with a keyset cursor (`after` = the last `key` of
   * the previous page), never `offset` — the catalog keeps changing
   * underneath a page. `key` is the primary key, so the cursor is exact
   * (no timestamp-precision concerns).
   */
  search(options?: SearchPermissionsOptions): Promise<Permission[]>;
  /** Total permissions matching `query` (or all, if omitted). */
  count(options?: { query?: string; grantedToRole?: string; grantedToMember?: string }): Promise<number>;
  /**
   * For each given permission key, how many roles (across every
   * organization) currently have it granted. Keys granted to no role are
   * present with `0`. One call for a whole page — avoids per-key/per-org
   * lookups.
   */
  countRoleGrants(keys: string[]): Promise<Record<string, number>>;
  /**
   * Removes a catalog entry. Rejects (`PermissionError`) if `key` was
   * never registered, or if it is still granted to at least one role in
   * any organization — the caller must revoke it everywhere first. This
   * keeps a single call from silently revoking access across every
   * tenant that had it granted (uniora-security-engineering skill §59,
   * "Destructive Operations" — cross-tenant impact must be reviewed).
   */
  unregister(key: string): Promise<void>;
}
