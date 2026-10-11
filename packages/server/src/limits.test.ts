import { describe, expect, it } from "vitest";
import { ConcurrencyGate, FailureThrottle, RateLimiter } from "./limits.js";

describe("RateLimiter", () => {
  it("allows a burst, then refills at the steady rate", () => {
    let now = 0;
    const limiter = new RateLimiter({ perSecond: 2, burst: 3, now: () => now });
    expect([1, 2, 3].map(() => limiter.take("k").allowed)).toEqual([true, true, true]);
    const refused = limiter.take("k");
    expect(refused).toMatchObject({ allowed: false, remaining: 0, limit: 3 });
    expect(refused.retryAfterSeconds).toBe(1);

    now = 500; // one token back
    expect(limiter.take("k").allowed).toBe(true);
    expect(limiter.take("k").allowed).toBe(false);
    now = 60_000; // long idle never banks more than the burst
    expect([1, 2, 3, 4].map(() => limiter.take("k").allowed)).toEqual([true, true, true, false]);
  });

  it("keeps one caller's bucket apart from another's", () => {
    const limiter = new RateLimiter({ perSecond: 1, burst: 1, now: () => 0 });
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
    expect(limiter.take("b").allowed).toBe(true);
  });

  it("forgets the least recently seen callers instead of growing without bound", () => {
    const limiter = new RateLimiter({ perSecond: 1, burst: 1, maxEntries: 100, now: () => 0 });
    for (let i = 0; i < 10_000; i++) limiter.take(`key-${i}`);
    expect(limiter.size).toBe(100);
  });

  it("rejects nonsense configuration", () => {
    expect(() => new RateLimiter({ perSecond: 0, burst: 1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ perSecond: 1, burst: 0 })).toThrow(RangeError);
  });
});

describe("ConcurrencyGate", () => {
  it("caps per key and overall, and frees a slot exactly once", () => {
    const gate = new ConcurrencyGate({ perKey: 2, global: 3 });
    const a1 = gate.acquire("a") as { release: () => void };
    const a2 = gate.acquire("a") as { release: () => void };
    expect(gate.acquire("a")).toEqual({ rejected: "key" });
    const b1 = gate.acquire("b") as { release: () => void };
    expect(gate.acquire("c")).toEqual({ rejected: "global" });
    expect(gate.inFlight).toBe(3);

    a1.release();
    a1.release(); // a second release must not free someone else's slot
    expect(gate.inFlight).toBe(2);
    expect(gate.acquire("a")).toHaveProperty("release");
    a2.release();
    b1.release();
  });
});

describe("FailureThrottle", () => {
  it("blocks a source after too many failures, until the window passes", () => {
    let now = 0;
    const throttle = new FailureThrottle({ maxFailures: 3, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 2; i++) throttle.recordFailure("1.2.3.4");
    expect(throttle.blockedFor("1.2.3.4")).toBe(0);
    throttle.recordFailure("1.2.3.4");
    expect(throttle.blockedFor("1.2.3.4")).toBe(60);
    expect(throttle.blockedFor("5.6.7.8")).toBe(0);

    now = 30_000;
    expect(throttle.blockedFor("1.2.3.4")).toBe(30);
    now = 60_000;
    expect(throttle.blockedFor("1.2.3.4")).toBe(0);
    expect(throttle.size).toBe(0);
  });

  it("is bounded", () => {
    const throttle = new FailureThrottle({ maxFailures: 1, windowMs: 60_000, maxEntries: 50, now: () => 0 });
    for (let i = 0; i < 5000; i++) throttle.recordFailure(`10.0.${i >> 8}.${i & 255}`);
    expect(throttle.size).toBe(50);
  });
});
