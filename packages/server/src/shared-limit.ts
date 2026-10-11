import type { RateLimitRepository } from "@uniora/core";
import type { RateLimitDecision, RateLimiter } from "./limits.js";

export interface SharedRateLimiterOptions {
  readonly store: RateLimitRepository;
  readonly perSecond: number;
  readonly burst: number;
  /** What a process that cannot reach the store uses instead: its own limit, so a database hiccup never means "no limit". */
  readonly fallback: RateLimiter;
  /** Called (at most every 30 s) when the store failed and the fallback answered. */
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

const LEASE_TTL_MS = 2_000;
const MAX_ENTRIES = 10_000;
const ERROR_REPORT_EVERY_MS = 30_000;

/**
 * A rate limit shared by every instance of the server. One token bucket per API key lives in the storage (`rateLimits`); a process
 * does not ask it on every request: it takes a LEASE of a tenth of the burst and spends it locally, so the storage sees one short
 * statement per lease instead of one per request. Tokens that are not spent within two seconds are dropped (an idle process does not
 * hoard budget), and concurrent requests of a key share one lease call.
 *
 * It is a limit, not a ledger: a lease is a promise of at most that many requests in the next two seconds, so the total across
 * instances can be a few tokens above the configured rate while leases are in flight. It never lets N instances each allow the full rate.
 */
export class SharedRateLimiter {
  private readonly held = new Map<string, { tokens: number; expiresAt: number; emptyUntil: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly lease: number;
  private readonly now: () => number;
  private lastReport = 0;

  constructor(private readonly options: SharedRateLimiterOptions) {
    this.lease = Math.max(1, Math.ceil(options.burst / 10));
    this.now = options.now ?? Date.now;
  }

  async take(key: string): Promise<RateLimitDecision> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = this.held.get(key);
      if (entry && entry.expiresAt > this.now() && entry.tokens >= 1) {
        entry.tokens -= 1;
        return { allowed: true, remaining: Math.floor(entry.tokens), limit: this.options.burst, retryAfterSeconds: 0 };
      }
      // A bucket that was empty a moment ago is not asked again until a token could have come back: a flood of refused requests must
      // not become a flood of statements.
      if (entry && entry.tokens < 1 && entry.emptyUntil > this.now()) break;
      try {
        await this.refill(key);
      } catch (error) {
        this.report(error);
        return this.options.fallback.take(key);
      }
    }
    return { allowed: false, remaining: 0, limit: this.options.burst, retryAfterSeconds: Math.max(1, Math.ceil(1 / this.options.perSecond)) };
  }

  private refill(key: string): Promise<void> {
    let inflight = this.pending.get(key);
    if (!inflight) {
      inflight = this.options.store
        .lease({ key, perSecond: this.options.perSecond, burst: this.options.burst, amount: this.lease })
        .then((granted) => {
          this.held.delete(key); // re-inserted last: the map is ordered least recently used first
          this.held.set(key, { tokens: granted, expiresAt: this.now() + LEASE_TTL_MS, emptyUntil: granted > 0 ? 0 : this.now() + Math.max(100, 1000 / this.options.perSecond) });
          while (this.held.size > MAX_ENTRIES) {
            const oldest = this.held.keys().next().value;
            if (oldest === undefined) break;
            this.held.delete(oldest);
          }
        })
        .finally(() => {
          this.pending.delete(key);
        });
      this.pending.set(key, inflight);
    }
    return inflight;
  }

  private report(error: unknown): void {
    const at = this.now();
    if (at - this.lastReport < ERROR_REPORT_EVERY_MS) return;
    this.lastReport = at;
    this.options.onError?.(error);
  }

  get size(): number {
    return this.held.size;
  }
}
