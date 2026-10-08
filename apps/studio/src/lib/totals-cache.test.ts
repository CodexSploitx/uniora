import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { cachedTotal, clearCachedTotals } from "@/lib/totals-cache";

describe("cachedTotal", () => {
  beforeEach(() => clearCachedTotals());

  it("answers from the cache until the ttl passes, then refreshes in the background", async () => {
    let clock = 0;
    let value = 1;
    const load = vi.fn(async () => value);
    expect(await cachedTotal("k", 1000, load, () => clock)).toBe(1);
    value = 2;
    expect(await cachedTotal("k", 1000, load, () => clock)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    clock = 1500;
    expect(await cachedTotal("k", 1000, load, () => clock)).toBe(1); // stale answer, refresh started
    await Promise.resolve();
    await Promise.resolve();
    expect(await cachedTotal("k", 1000, load, () => clock)).toBe(2);
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

  it("does not cache a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(3);
    await expect(cachedTotal("f", 1000, load)).rejects.toThrow("down");
    expect(await cachedTotal("f", 1000, load)).toBe(3);
  });
});
