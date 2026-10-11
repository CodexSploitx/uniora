import { ApiCredentialError } from "./errors.js";

export interface RateLeaseInput {
  /** The bucket: the id of an API key. */
  key: string;
  /** Steady refill, tokens per second. */
  perSecond: number;
  /** Bucket size, and what a bucket that has not been used holds. */
  burst: number;
  /** How many whole tokens the caller would like. */
  amount: number;
  /** The moment, for tests. Never set by the server: the databases use their own clock so that instances with different clocks agree. */
  at?: Date;
}

/**
 * The shared rate limit of the API server: one token bucket per API key, kept in the storage so that every instance of the server
 * draws from the same budget. An instance does not ask per request: it takes a small LEASE of tokens and spends it on its own.
 */
export interface RateLimitRepository {
  /**
   * Takes up to `amount` whole tokens from the bucket and returns how many it got (0 when the bucket is empty). The refill since
   * the last call is added first, up to `burst`. Atomic: concurrent leases never hand out more than the bucket holds.
   */
  lease(input: RateLeaseInput): Promise<number>;
}

export const MAX_RATE_KEY_LENGTH = 64;

export function assertRateLease(input: RateLeaseInput): void {
  if (typeof input?.key !== "string" || input.key.length < 1 || input.key.length > MAX_RATE_KEY_LENGTH) throw new ApiCredentialError("The rate limit key must be 1 to 64 characters.", "api_invalid");
  for (const [name, value, min, max] of [["perSecond", input.perSecond, 0.001, 1_000_000], ["burst", input.burst, 1, 1_000_000], ["amount", input.amount, 1, 1_000_000]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ApiCredentialError(`The rate limit \`${name}\` must be a number from ${min} to ${max}.`, "api_invalid");
  }
  if (!Number.isInteger(input.burst) || !Number.isInteger(input.amount)) throw new ApiCredentialError("The rate limit `burst` and `amount` must be whole numbers.", "api_invalid");
}

/**
 * The arithmetic of one lease, shared by the backends that do it in code (the databases that do it in SQL must agree with it, and
 * the conformance suite holds them to it): refill since `updatedMs`, cap at `burst`, hand out whole tokens.
 */
export function leaseFromBucket(bucket: { tokens: number; updatedMs: number } | undefined, input: RateLeaseInput, nowMs: number): { granted: number; tokens: number } {
  const held = bucket === undefined ? input.burst : Math.min(input.burst, bucket.tokens + Math.max(0, (nowMs - bucket.updatedMs) / 1000) * input.perSecond);
  const granted = Math.min(input.amount, Math.floor(held));
  return { granted, tokens: held - granted };
}
