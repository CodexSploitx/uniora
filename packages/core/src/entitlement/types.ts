/**
 * How often the usage of an entitlement starts over (UTC): `lifetime` never (a running total or a gauge such as seats,
 * which `release` gives back), `daily` and `monthly` at the start of each UTC day or month.
 */
export type EntitlementPeriod = "lifetime" | "daily" | "monthly";

/** A quantity an organization may use, defined once for everyone (`seats`, `vehicles`, `reports_per_month`). */
export interface EntitlementDefinition {
  readonly key: string;
  name: string;
  description?: string;
  period: EntitlementPeriod;
  /** What an organization with no override of its own gets; `null` is unlimited. */
  defaultLimit: number | null;
}

/** Where an organization's limit comes from: a value set for it (`override`, `null` meaning "unlimited for this one") or the definition's `defaultLimit`. */
export type EntitlementLimitSource = "override" | "default";

/** One organization's standing on one entitlement, in the current window. */
export interface EntitlementStatus {
  readonly organizationId: string;
  readonly key: string;
  readonly period: EntitlementPeriod;
  /** `null` is unlimited. */
  readonly limit: number | null;
  readonly source: EntitlementLimitSource;
  readonly used: number;
  /** `limit - used`, at least 0; `null` when unlimited. */
  readonly remaining: number | null;
  /** Start (inclusive) and end (exclusive) of the window `used` counts; no end for `lifetime`. */
  readonly windowStart?: Date;
  readonly windowEnd?: Date;
}

export interface ConsumeResult {
  /** False when taking `amount` would pass the limit: nothing was consumed. */
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
}
