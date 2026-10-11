import { createMemoryApiCredentialStorage } from "@uniora/core";
import type { RateLimitRepository } from "@uniora/core";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "./limits.js";
import { SharedRateLimiter } from "./shared-limit.js";
import { BACKENDS, startFixture } from "./test-support/harness.js";

const clock = (start = 1_000_000) => {
  const state = { now: start };
  return { state, now: () => state.now };
};

describe("SharedRateLimiter", () => {
  it("spends a lease locally and asks the store once per lease, not once per request", async () => {
    const storage = createMemoryApiCredentialStorage();
    let calls = 0;
    const store: RateLimitRepository = { lease: (input) => (calls++, storage.rateLimits.lease(input)) };
    const c = clock();
    const limiter = new SharedRateLimiter({ store, perSecond: 1, burst: 20, fallback: new RateLimiter({ perSecond: 1, burst: 20, now: c.now }), now: c.now });
    let allowed = 0;
    for (let i = 0; i < 20; i++) if ((await limiter.take("k")).allowed) allowed += 1;
    expect(allowed).toBe(20);
    expect(calls).toBe(10); // leases of 2
    expect((await limiter.take("k")).allowed).toBe(false);
  });

  it("two instances over one store share one budget", async () => {
    const storage = createMemoryApiCredentialStorage();
    const c = clock();
    const make = () => new SharedRateLimiter({ store: storage.rateLimits, perSecond: 0.001, burst: 40, fallback: new RateLimiter({ perSecond: 0.001, burst: 40, now: c.now }), now: c.now });
    const [a, b] = [make(), make()];
    let allowed = 0;
    for (let i = 0; i < 100; i++) if ((await (i % 2 === 0 ? a : b).take("k")).allowed) allowed += 1;
    expect(allowed).toBe(40);
  });

  it("concurrent requests of one key share one lease call", async () => {
    let calls = 0;
    const storage = createMemoryApiCredentialStorage();
    const store: RateLimitRepository = { lease: async (input) => (calls++, new Promise((resolve) => setTimeout(resolve, 10)).then(() => storage.rateLimits.lease(input))) };
    const c = clock();
    const limiter = new SharedRateLimiter({ store, perSecond: 10, burst: 100, fallback: new RateLimiter({ perSecond: 10, burst: 100, now: c.now }), now: c.now });
    const results = await Promise.all(Array.from({ length: 8 }, () => limiter.take("k")));
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(calls).toBe(1);
  });

  it("drops a lease nobody spent, so an idle process does not hoard budget", async () => {
    const storage = createMemoryApiCredentialStorage();
    const c = clock();
    const limiter = new SharedRateLimiter({ store: storage.rateLimits, perSecond: 0.001, burst: 100, fallback: new RateLimiter({ perSecond: 1, burst: 1, now: c.now }), now: c.now });
    await limiter.take("k"); // leases 10, spends 1
    c.state.now += 3_000;
    const spent = await storage.rateLimits.lease({ key: "k", perSecond: 0.001, burst: 100, amount: 100 });
    expect(spent).toBe(90); // the 10 that were leased are gone (spent or dropped), not given back; the other 90 are still there
  });

  it("does not turn a flood of refused requests into a flood of statements", async () => {
    let calls = 0;
    const storage = createMemoryApiCredentialStorage();
    const store: RateLimitRepository = { lease: (input) => (calls++, storage.rateLimits.lease(input)) };
    const limiter = new SharedRateLimiter({ store, perSecond: 20, burst: 1, fallback: new RateLimiter({ perSecond: 20, burst: 1 }) });
    expect((await limiter.take("k")).allowed).toBe(true);
    const before = calls;
    for (let i = 0; i < 500; i++) expect((await limiter.take("k")).allowed).toBe(false);
    expect(calls - before).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect((await limiter.take("k")).allowed).toBe(true);
  });

  it("limits per process when the store fails, and says so once", async () => {
    const errors: unknown[] = [];
    const c = clock();
    const limiter = new SharedRateLimiter({
      store: { lease: () => Promise.reject(new Error("down")) },
      perSecond: 1,
      burst: 3,
      fallback: new RateLimiter({ perSecond: 1, burst: 3, now: c.now }),
      onError: (error) => errors.push(error),
      now: c.now,
    });
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push((await limiter.take("k")).allowed);
    expect(answers).toEqual([true, true, true, false, false, false]);
    expect(errors).toHaveLength(1);
  });
});

describe.each(BACKENDS)("two server instances over %s", (backend) => {
  it("share the rate limit of a key when sharedRateLimit is on, and each allow the full rate when it is off", async () => {
    const run = async (shared: boolean) => {
      const a = await startFixture(backend, { sharedRateLimit: shared, limits: { ratePerSecond: 1, rateBurst: 20 } });
      // The second instance is another server over the SAME storages.
      const { createUnioraServer, silentLogger } = await import("./index.js");
      const second = await createUnioraServer({ storage: a.backend.storage, credentials: a.backend.credentials, defaultProvider: "main", logger: silentLogger, sharedRateLimit: shared, limits: { ratePerSecond: 1, rateBurst: 20 } }).listen({ port: 0 });
      try {
        const { token } = await a.issue();
        let allowed = 0;
        for (let i = 0; i < 60; i++) {
          const url = i % 2 === 0 ? a.server.url : second.url;
          const response = await fetch(`${url}/v1/permissions`, { headers: { authorization: `Bearer ${token}` } });
          if (response.status === 200) allowed += 1;
        }
        return allowed;
      } finally {
        await second.close(500);
        await a.stop();
      }
    };
    expect(await run(true)).toBeLessThanOrEqual(26);
    expect(await run(false)).toBeGreaterThanOrEqual(38);
  });
});
