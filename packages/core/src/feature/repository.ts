import type { Feature, FeatureDefinition } from "./types.js";

export class FeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureError";
  }
}

export interface RegisterFeatureInput {
  /**
   * Stable, URL-safe handle, unique across the whole catalog (global,
   * like `Permission.key` — a feature isn't scoped to one organization).
   * Optional — derived from `name` when omitted (see `resolveFeatureKey`).
   */
  key?: string;
  name: string;
  description?: string;
}

export interface SearchFeaturesOptions {
  limit?: number;
  /** Keyset cursor — only features whose `key` sorts strictly after this one are returned. */
  after?: string;
  /** Case-insensitive substring match against `key` or `name`. Empty/omitted matches everything. */
  query?: string;
  /** Only features currently enabled for this organization. */
  enabledIn?: string;
}

export interface FeatureUsage {
  /** Organizations where the feature is currently enabled. */
  enabledCount: number;
  /** Up to `sampleSize` of those organization ids, in a stable order — for a "used by…" preview. */
  sampleOrganizationIds: string[];
}

export interface FeatureRepository {
  /**
   * Creates or updates a catalog entry — idempotent upsert, same contract
   * as `PermissionRepository.register` (re-registering the same `key`
   * with new `name`/`description` updates it, it never throws on an
   * existing key). `name` is sanitized and `key` resolved/validated the
   * same way as `Organization.slug`/`Role.key` (see `resolveFeatureKey`).
   */
  register(input: RegisterFeatureInput): Promise<FeatureDefinition>;
  /** Whole catalog, unpaginated — internal aggregation only. UIs should use `search`. */
  listCatalog(): Promise<FeatureDefinition[]>;
  /** Paginated, optionally filtered catalog (keyset on `key`, never `offset`). */
  search(options?: SearchFeaturesOptions): Promise<FeatureDefinition[]>;
  /** Total catalog entries matching `query` (or all, if omitted). */
  count(options?: { query?: string; enabledIn?: string }): Promise<number>;
  /**
   * For each given feature key: how many organizations have it enabled plus
   * a small sample of those organization ids. One call for a whole page —
   * never one lookup per feature or per organization. Keys enabled nowhere
   * are present with `{ enabledCount: 0, sampleOrganizationIds: [] }`.
   */
  /** Which of `keys` are enabled for `organizationId` — one call for a whole page of features. */
  enabledKeys(organizationId: string, keys: string[]): Promise<string[]>;
  /**
   * Enabled features per organization for a batch of organization ids, in
   * one call. Every requested id is present (`0` when none enabled).
   */
  countEnabledByOrganization(organizationIds: string[]): Promise<Record<string, number>>;
  summarizeUsage(keys: string[], sampleSize: number): Promise<Record<string, FeatureUsage>>;
  /** Rejects (`FeatureError`, fail-closed) if `key` was never registered via `register()`. */
  enable(organizationId: string, key: string): Promise<void>;
  /** Rejects (`FeatureError`, fail-closed) if `key` was never registered via `register()`. */
  disable(organizationId: string, key: string): Promise<void>;
  isEnabled(organizationId: string, key: string): Promise<boolean>;
  listByOrganization(organizationId: string): Promise<Feature[]>;
  /**
   * Removes a catalog entry. Rejects (`FeatureError`) if `key` was never
   * registered, or if it is currently enabled for at least one
   * organization — the caller must disable it everywhere first. Same
   * cross-tenant safety rationale as `PermissionRepository.unregister`
   * (uniora-security-engineering skill §59). Per-organization toggles left
   * disabled for this key are removed as part of the same operation.
   */
  unregister(key: string): Promise<void>;
}
