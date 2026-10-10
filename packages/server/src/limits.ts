/**
 * Resource limits for the API, all in memory and all BOUNDED themselves: a limiter that grows with the number of callers
 * is a denial-of-service of its own. They are per process: with N instances the effective limit is N times the configured
 * one (a shared limiter is on the roadmap). The clock is injectable so the tests need no sleeping.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests left in the bucket after this one. */
  readonly remaining: number;
  readonly limit: number;
  /** Seconds until one more request would be allowed (0 when allowed). */
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Steady refill, requests per second. */
  perSecond: number;
  /** Bucket size: the most a quiet caller can send at once. */
  burst: number;
  /** At most this many callers are tracked; the least recently seen are forgotten first. */
  maxEntries?: number;
  now?: () => number;
}

/** A token bucket per key. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (!(options.perSecond > 0) || !(options.burst >= 1)) throw new RangeError("RateLimiter needs perSecond > 0 and burst >= 1.");
    this.perSecond = options.perSecond;
    this.burst = Math.floor(options.burst);
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  take(key: string): RateLimitDecision {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at };
    this.buckets.delete(key); // re-inserted below: Map order = least recently used first
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((at - bucket.at) / 1000) * this.perSecond);
    bucket.at = at;

    let decision: RateLimitDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = { allowed: true, remaining: Math.floor(bucket.tokens), limit: this.burst, retryAfterSeconds: 0 };
    } else {
      decision = { allowed: false, remaining: 0, limit: this.burst, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.perSecond)) };
    }
    this.buckets.set(key, bucket);
    while (this.buckets.size > this.maxEntries) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return decision;
  }

  get size(): number {
    return this.buckets.size;
  }
}

export interface ConcurrencyGateOptions {
  /** In-flight requests allowed per key. */
  perKey: number;
  /** In-flight requests allowed in the whole process. */
  global: number;
}

/** Caps simultaneous requests, per caller and overall, so one slow or greedy client cannot take every connection. */
export class ConcurrencyGate {
  private readonly perKeyCount = new Map<string, number>();
  private total = 0;

  constructor(private readonly options: ConcurrencyGateOptions) {}

  /** A release function, or `null` with the reason the request was not admitted. Call the release exactly once. */
  acquire(key: string): { release: () => void } | { rejected: "key" | "global" } {
    if (this.total >= this.options.global) return { rejected: "global" };
    const current = this.perKeyCount.get(key) ?? 0;
    if (current >= this.options.perKey) return { rejected: "key" };
    this.perKeyCount.set(key, current + 1);
    this.total += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        const left = (this.perKeyCount.get(key) ?? 1) - 1;
        if (left <= 0) this.perKeyCount.delete(key);
        else this.perKeyCount.set(key, left);
      },
    };
  }

  /** Requests in flight right now. */
  get inFlight(): number {
    return this.total;
  }
}

export interface FailureThrottleOptions {
  /** Failures from one source within the window before it is refused. */
  maxFailures: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Slows down guessing: after `maxFailures` failed authentications from one source address inside the window, that source is
 * refused (429) until the window passes, WITHOUT looking at its credentials. A successful request does not clear the count,
 * or an attacker holding one valid key could interleave guesses with good requests.
 */
export class FailureThrottle {
  private readonly entries = new Map<string, { count: number; windowStart: number }>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: FailureThrottleOptions) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Seconds the source must wait, or 0 when it may try. */
  blockedFor(source: string): number {
    const entry = this.entries.get(source);
    if (!entry) return 0;
    const elapsed = this.now() - entry.windowStart;
    if (elapsed >= this.options.windowMs) {
      this.entries.delete(source);
      return 0;
    }
    return entry.count >= this.options.maxFailures ? Math.max(1, Math.ceil((this.options.windowMs - elapsed) / 1000)) : 0;
  }

  recordFailure(source: string): void {
    const at = this.now();
    const entry = this.entries.get(source);
    if (!entry || at - entry.windowStart >= this.options.windowMs) {
      this.entries.delete(source);
      this.entries.set(source, { count: 1, windowStart: at });
    } else {
      entry.count += 1;
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
