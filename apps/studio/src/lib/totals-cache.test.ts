import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cachedTotal, clearCachedTotals } from "@/lib/totals-cache";

describe("cachedTotal", () => {
  beforeEach(() => clearCachedTotals());

  it("answers from the cache until the ttl passes, then refreshes in the background", async () => {
    let clock = 0;
    let value = 1;
    const load = vi.fn(async () => value);
    expect(await cachedTotal("k", 1000, load, { now: () => clock })).toBe(1);
    value = 2;
    expect(await cachedTotal("k", 1000, load, { now: () => clock })).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    clock = 1500;
    expect(await cachedTotal("k", 1000, load, { now: () => clock })).toBe(1); // stale answer, refresh started
    await Promise.resolve();
    await Promise.resolve();
    expect(await cachedTotal("k", 1000, load, { now: () => clock })).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one query between concurrent first requests and forgets everything when cleared", async () => {
    const load = vi.fn(async () => 7);
    await Promise.all([cachedTotal("a", 1000, load), cachedTotal("a", 1000, load), cachedTotal("a", 1000, load)]);
    expect(load).toHaveBeenCalledTimes(1);
    clearCachedTotals();
    await cachedTotal("a", 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("answers the very first request with the cheap fallback and has the exact value ready for the next", async () => {
    const load = vi.fn(async () => 5_000_000);
    const fallback = vi.fn(async () => 10_001);
    expect(await cachedTotal("big", 1000, load, { fallback })).toBe(10_001);
    await Promise.resolve();
    await Promise.resolve();
    expect(await cachedTotal("big", 1000, load, { fallback })).toBe(5_000_000);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("serves the old value while a write-expired total reloads", async () => {
    let value = 1;
    const load = vi.fn(async () => value);
    await cachedTotal("w", 60_000, load);
    value = 2;
    clearCachedTotals();
    expect(await cachedTotal("w", 60_000, load)).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(await cachedTotal("w", 60_000, load)).toBe(2);
  });

  it("does not cache a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(3);
    await expect(cachedTotal("f", 1000, load)).rejects.toThrow("down");
    expect(await cachedTotal("f", 1000, load)).toBe(3);
  });
});
