import type { Identity } from "../identity/types.js";

/**
 * A per-organization override of a feature: an explicit row that says "on" or "off" for this
 * organization, whoever or whatever set it. An organization WITHOUT a row simply follows the
 * feature's `defaultEnabled` — see `FeatureRepository.isEnabled` / `listEffective`.
 */
export interface Feature {
  readonly organizationId: string;
  readonly key: string;
  enabled: boolean;
  /** When the override last changed. Absent on rows written before change metadata existed. */
  readonly updatedAt?: Date;
  /** Who changed it, when the caller said so (`FeatureChangeMeta.actor`). */
  readonly updatedBy?: Identity;
  /** Why it was changed, when the caller said so. */
  readonly reason?: string;
}

/**
 * A catalog entry: the definition of a feature that can be toggled for an
 * organization. `enable`/`disable` reject a `key` that was never
 * registered here (fail-closed — uniora-security-engineering INV-007,
 * "Unknown Features Deny" — extended to creation time, not just
 * evaluation). Distinct from `Feature`: this is the global definition
 * (like `Permission`), `Feature` is the per-organization toggle.
 */
export interface FeatureDefinition {
  readonly key: string;
  name: string;
  description?: string;
  /**
   * What an organization with NO override gets. `false` (the default) keeps the historical
   * behaviour — a feature is off until someone turns it on. `true` makes a new feature born
   * active for every organization, with no row to backfill.
   */
  defaultEnabled: boolean;
  /**
   * Another registered feature this one depends on: it is effectively on only while the parent is
   * too (turning `workspace` off turns `workspace_*` off). Absent for a root feature.
   */
  parentKey?: string;
}

/** Who changed a feature and why — stored on the override and surfaced in `Feature` / `listEffective`. */
export interface FeatureChangeMeta {
  actor?: Identity;
  /** Free text, trimmed and capped at 500 characters. */
  reason?: string;
}

/**
 * Why a feature is on or off for an organization:
 * - `enabled` / `disabled`: an explicit override says so.
 * - `default`: no override — the feature's `defaultEnabled` applies (on or off, see `enabled`).
 * - `parent_disabled`: the feature itself is on, but an ancestor is off (`blockedBy` names it).
 */
export type EffectiveFeatureReason = "enabled" | "disabled" | "default" | "parent_disabled";

export interface EffectiveFeature {
  readonly key: string;
  /** The final answer `isEnabled` / `access.check` / snapshots use. */
  readonly enabled: boolean;
  readonly reason: EffectiveFeatureReason;
  readonly defaultEnabled: boolean;
  readonly parentKey?: string;
  /** The nearest ancestor that is switched off, when `reason` is `parent_disabled`. */
  readonly blockedBy?: string;
  /** The override that decided it, if there is one. */
  readonly override?: { enabled: boolean; updatedAt?: Date; updatedBy?: Identity; reason?: string };
}
