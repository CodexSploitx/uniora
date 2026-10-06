import { UnioraError } from "../shared/errors.js";
import type { ConsumeResult, EntitlementDefinition, EntitlementPeriod, EntitlementStatus } from "./types.js";

export type EntitlementErrorCode =
  | "entitlement_unknown"
  | "entitlement_key_invalid"
  | "entitlement_name_invalid"
  | "entitlement_invalid"
  | "entitlement_limit_invalid"
  | "entitlement_amount_invalid"
  | "entitlement_organization_unknown"
  | "entitlement_limit_exceeded";

export class EntitlementError extends UnioraError {
  constructor(message: string, code: EntitlementErrorCode = "entitlement_invalid") {
    super(message, code);
    this.name = "EntitlementError";
  }
}

export interface DefineEntitlementInput {
  /** Lowercase alphanumeric segments separated by single underscores, at most 63 characters (`reports_per_month`). */
  key: string;
  name?: string;
  description?: string;
  /** Default `lifetime`. */
  period?: EntitlementPeriod;
  /** Default `null` (unlimited). A whole number, 0 or more. */
  defaultLimit?: number | null;
}

export interface EntitlementClock {
  /** The clock that decides the current window; for tests and for batch jobs that want one reading. */
  now?: Date;
}

/**
 * Per-organization quotas: how many seats, vehicles or monthly reports an organization may use. UNIORA doesn't know
 * your plans or licences; the host decides each organization's limit (`setLimit`, usually from its own billing data)
 * and calls `consume` before doing the thing. `consume` is an atomic check-and-take, so two concurrent requests can't
 * both slip under the limit.
 */
export interface EntitlementRepository {
  /** Creates or updates a definition (a full upsert, like `features.register`). Changing `period` starts a new window. */
  define(input: DefineEntitlementInput): Promise<EntitlementDefinition>;
  findDefinition(key: string): Promise<EntitlementDefinition | null>;
  listDefinitions(): Promise<EntitlementDefinition[]>;
  /** Removes a definition together with every override and usage row. */
  undefine(key: string): Promise<void>;
  /** Sets this organization's own limit: a whole number, 0 or more, or `null` for unlimited. */
  setLimit(organizationId: string, key: string, limit: number | null): Promise<EntitlementStatus>;
  /** Removes the organization's own limit; it follows the definition's `defaultLimit` again. */
  clearLimit(organizationId: string, key: string): Promise<EntitlementStatus>;
  /** The standing of one organization on one entitlement (`entitlement_unknown` for an undefined key). */
  get(organizationId: string, key: string, options?: EntitlementClock): Promise<EntitlementStatus>;
  /** Every defined entitlement for one organization. */
  list(organizationId: string, options?: EntitlementClock): Promise<EntitlementStatus[]>;
  /**
   * Takes `amount` (default 1) if it fits under the limit, atomically; otherwise takes nothing and answers
   * `allowed: false`. An unlimited entitlement always allows (and still counts, so you can report usage).
   */
  consume(organizationId: string, key: string, amount?: number, options?: EntitlementClock): Promise<ConsumeResult>;
  /** Gives back `amount` (default 1) in the current window, never below 0; for a gauge like seats when one is freed. */
  release(organizationId: string, key: string, amount?: number, options?: EntitlementClock): Promise<ConsumeResult>;
}

const KEY_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;
export const MAX_ENTITLEMENT_KEY_LENGTH = 63;
export const MAX_ENTITLEMENT_AMOUNT = 1_000_000_000;

export function assertValidEntitlementKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new EntitlementError("Entitlement key cannot be empty.", "entitlement_key_invalid");
  if (key.length > MAX_ENTITLEMENT_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new EntitlementError(
      `Entitlement key must be lowercase alphanumeric characters separated by single underscores, at most ${MAX_ENTITLEMENT_KEY_LENGTH} characters (e.g. "reports_per_month").`,
      "entitlement_key_invalid",
    );
  }
  return key;
}

/** A limit: a whole number from 0 up, or `null` for unlimited. */
export function assertValidEntitlementLimit(limit: unknown): number | null {
  if (limit === null) return null;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
    throw new EntitlementError("A limit must be a whole number of 0 or more, or null for unlimited.", "entitlement_limit_invalid");
  }
  return limit;
}

export function assertValidEntitlementAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_ENTITLEMENT_AMOUNT) {
    throw new EntitlementError(`The amount must be a whole number between 1 and ${MAX_ENTITLEMENT_AMOUNT}.`, "entitlement_amount_invalid");
  }
  return amount;
}

export function sanitizeEntitlementName(name: string | undefined, key: string): string {
  if (name === undefined) return key;
  if (typeof name !== "string") throw new EntitlementError("Entitlement name must be text.", "entitlement_name_invalid");
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed === "" || trimmed.length > 100) {
    throw new EntitlementError("Entitlement name must be 1 to 100 characters.", "entitlement_name_invalid");
  }
  return trimmed;
}

export function assertValidEntitlementPeriod(period: unknown): EntitlementPeriod {
  if (period === "lifetime" || period === "daily" || period === "monthly") return period;
  throw new EntitlementError('The period must be "lifetime", "daily" or "monthly".');
}

/** The usage window (UTC) a moment falls in. `lifetime` is one window since the epoch with no end. */
export function entitlementWindow(period: EntitlementPeriod, now: Date): { start: Date; end?: Date } {
  if (period === "lifetime") return { start: new Date(0) };
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === "monthly") return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
  const day = now.getUTCDate();
  return { start: new Date(Date.UTC(year, month, day)), end: new Date(Date.UTC(year, month, day + 1)) };
}

/** Builds a status from the pieces every backend reads the same way. */
export function buildEntitlementStatus(parts: {
  organizationId: string;
  definition: Pick<EntitlementDefinition, "key" | "period" | "defaultLimit">;
  override: { limit: number | null } | undefined;
  used: number;
  now: Date;
}): EntitlementStatus {
  const { definition, override, used } = parts;
  const limit = override ? override.limit : definition.defaultLimit;
  const window = entitlementWindow(definition.period, parts.now);
  return {
    organizationId: parts.organizationId,
    key: definition.key,
    period: definition.period,
    limit,
    source: override ? "override" : "default",
    used,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    windowStart: window.start,
    windowEnd: window.end,
  };
}

export function toConsumeResult(status: Pick<EntitlementStatus, "limit" | "used" | "remaining">, allowed: boolean): ConsumeResult {
  return { allowed, used: status.used, limit: status.limit, remaining: status.remaining };
}
