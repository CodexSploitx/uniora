import { UnioraError, inferErrorCode } from "../shared/errors.js";
import type { PermissionErrorCode } from "../shared/errors.js";
import type { Permission } from "./types.js";

export class PermissionError extends UnioraError {
  constructor(message: string, code?: PermissionErrorCode) {
    super(message, code ?? inferErrorCode("permission", message));
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
  /** Catalog section, trimmed, at most 100 characters (`permission_group_invalid`). */
  group?: string;
  /**
   * Permissions this one implies (e.g. `["appointments.read"]`). Each must already be registered, so register the
   * implied ones first. No self-reference or cycle, at most 20 per permission and a chain of at most 8 levels
   * (`permission_implication_invalid`). Like the rest of the registration this is a full upsert: re-registering
   * without `implies` clears it.
   */
  implies?: string[];
}

export interface SearchPermissionsOptions {
  limit?: number;
  /** Keyset cursor — only permissions whose `key` sorts strictly after this one are returned. */
  after?: string;
  /** Case-insensitive substring match against `key` or `name`. Empty/omitted matches everything. */
  query?: string;
  /** Only permissions currently granted to this role. */
  grantedToRole?: string;
  /** Only permissions of this catalog group (exact match). */
  group?: string;
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
  count(options?: { query?: string; group?: string; grantedToRole?: string; grantedToMember?: string }): Promise<number>;
  /**
   * For each given permission key, how many roles (across every
   * organization) currently have it granted. Keys granted to no role are
   * present with `0`. One call for a whole page — avoids per-key/per-org
   * lookups.
   */
  countRoleGrants(keys: string[]): Promise<Record<string, number>>;
  /**
   * Every permission that implies `key`, directly or through others (not `key` itself), sorted. The authorization
   * engine uses it: a role holding any of them passes a check for `key`. Empty for a key nothing implies.
   */
  impliedBy(key: string): Promise<string[]>;
  /**
   * `keys` plus everything they imply, transitively (sorted, no duplicates): what a role holding `keys` can really
   * do. Unknown keys are returned as given. For role editors and "effective permissions" screens.
   */
  expand(keys: string[]): Promise<string[]>;
  /**
   * Removes a catalog entry. Rejects (`PermissionError`) if `key` was
   * never registered, if another permission still implies it
   * (`permission_has_dependents`), or if it is still granted to at least one role in
   * any organization — the caller must revoke it everywhere first. This
   * keeps a single call from silently revoking access across every
   * tenant that had it granted (uniora-security-engineering skill §59,
   * "Destructive Operations" — cross-tenant impact must be reviewed).
   */
  unregister(key: string): Promise<void>;
}
