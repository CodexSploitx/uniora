import { UnioraError, inferErrorCode } from "../shared/errors.js";
import type { FeatureErrorCode } from "../shared/errors.js";
import type { EffectiveFeature, Feature, FeatureChangeMeta, FeatureDefinition } from "./types.js";

export class FeatureError extends UnioraError {
  constructor(message: string, code?: FeatureErrorCode) {
    super(message, code ?? inferErrorCode("feature", message));
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
  /**
   * Whether organizations WITHOUT an override get the feature. Defaults to `false`. Re-registering is a
   * full upsert, so omitting it on a later `register` resets it to `false` — pass it every time.
   */
  defaultEnabled?: boolean;
  /**
   * Key of an already-registered feature this one depends on (effective = own state AND parent's).
   * Rejected (`FeatureError`, `feature_parent_invalid`) if it is unknown, is the feature itself, would close a
   * cycle, or would make the chain deeper than `MAX_FEATURE_DEPTH`. Re-registering without it detaches the feature.
   */
  parentKey?: string;
}

export interface SearchFeaturesOptions {
  limit?: number;
  /** Keyset cursor — only features whose `key` sorts strictly after this one are returned. */
  after?: string;
  /** Case-insensitive substring match against `key` or `name`. Empty/omitted matches everything. */
  query?: string;
  /** Only features EFFECTIVELY enabled for this organization (override or default, and every parent on). */
  enabledIn?: string;
}

export interface DisableEverywhereResult {
  /** Overrides that were on and are now off. */
  disabledOverrides: number;
  /** `true` if the feature was on by default for organizations without an override — the default is now off. */
  defaultWasEnabled: boolean;
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
  /**
   * Which of `keys` are EFFECTIVELY enabled for `organizationId` (override, else the feature's default,
   * and every parent on) — one call for a whole page of features.
   */
  enabledKeys(organizationId: string, keys: string[]): Promise<string[]>;
  /**
   * Effectively enabled features per organization for a batch of organization ids, in
   * one call. Every requested id is present (`0` when none enabled).
   */
  countEnabledByOrganization(organizationIds: string[]): Promise<Record<string, number>>;
  summarizeUsage(keys: string[], sampleSize: number): Promise<Record<string, FeatureUsage>>;
  /**
   * Turns the feature on for one organization (an explicit override). Rejects (`FeatureError`,
   * `feature_unknown`, fail-closed) if `key` was never registered via `register()`. `meta` records who did it
   * and why on the override (`updatedAt` is always recorded).
   */
  enable(organizationId: string, key: string, meta?: FeatureChangeMeta): Promise<void>;
  /** Same as `enable`, for turning it off. Rejects (`feature_unknown`) if `key` was never registered. */
  disable(organizationId: string, key: string, meta?: FeatureChangeMeta): Promise<void>;
  /**
   * Applies several on/off changes to one organization atomically: either every key is applied or — if any
   * is unregistered — none is (`feature_unknown`). The same `meta` is recorded on each.
   */
  setMany(organizationId: string, changes: Record<string, boolean>, meta?: FeatureChangeMeta): Promise<void>;
  /**
   * Kill switch: turns the feature off in EVERY organization — all overrides that were on are switched off
   * and the feature's default becomes off, so organizations without an override are covered too. To bring
   * it back, `register` it again with `defaultEnabled: true` and/or `enable` it per organization.
   * Rejects (`feature_unknown`) for an unregistered key.
   */
  disableEverywhere(key: string, meta?: FeatureChangeMeta): Promise<DisableEverywhereResult>;
  /**
   * The effective answer for one feature: the organization's override if it has one, else the feature's
   * `defaultEnabled`; and `false` whenever a parent is off. Unknown keys are `false` (fail-closed).
   */
  isEnabled(organizationId: string, key: string): Promise<boolean>;
  /**
   * The whole catalog resolved for one organization, with the reason each feature is on or off
   * (`enabled`, `disabled`, `default`, `parent_disabled`) — one call for a settings screen.
   * Optionally restricted to `keys`.
   */
  listEffective(organizationId: string, options?: { keys?: string[] }): Promise<EffectiveFeature[]>;
  /** The organization's explicit overrides only (rows), not the effective state — use `listEffective` for that. */
  listByOrganization(organizationId: string): Promise<Feature[]>;
  /**
   * Removes a catalog entry. Rejects (`FeatureError`) if `key` was never
   * registered (`feature_unknown`), if another feature names it as parent (`feature_has_children`), or if it is
   * currently enabled for at least one organization (`feature_in_use`) — the caller must disable it everywhere
   * first (`disableEverywhere`). Same
   * cross-tenant safety rationale as `PermissionRepository.unregister`
   * (uniora-security-engineering skill §59). Per-organization toggles left
   * disabled for this key are removed as part of the same operation.
   */
  unregister(key: string): Promise<void>;
}

/** Trims and caps the free-text `reason` of a change; `undefined` when empty. */
export function sanitizeFeatureChangeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}
