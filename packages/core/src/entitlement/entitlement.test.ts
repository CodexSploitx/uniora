import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { entitlementWindow } from "./repository.js";

const day = (offset: number) => new Date(Date.UTC(2026, 4, 15, 12) + offset * 24 * 3600 * 1000);

async function seed() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org-1", name: "Acme" });
  await storage.entitlements.define({ key: "seats", period: "lifetime", defaultLimit: 3 });
  await storage.entitlements.define({ key: "reports_per_month", period: "monthly", defaultLimit: 2 });
  return storage;
}

describe("entitlements (memory)", () => {
  it("windows are UTC calendar periods", () => {
    expect(entitlementWindow("monthly", new Date(Date.UTC(2026, 11, 31, 23, 59)))).toEqual({
      start: new Date(Date.UTC(2026, 11, 1)),
      end: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(entitlementWindow("daily", new Date(Date.UTC(2026, 1, 28, 23)))).toEqual({
      start: new Date(Date.UTC(2026, 1, 28)),
      end: new Date(Date.UTC(2026, 2, 1)),
    });
    expect(entitlementWindow("lifetime", new Date())).toEqual({ start: new Date(0) });
  });

  it("falls back to the default limit, overrides per organization and clears back", async () => {
    const { entitlements } = await seed();
    expect(await entitlements.get("org-1", "seats")).toMatchObject({ limit: 3, source: "default", remaining: 3 });
    expect(await entitlements.setLimit("org-1", "seats", 10)).toMatchObject({ limit: 10, source: "override" });
    expect(await entitlements.setLimit("org-1", "seats", null)).toMatchObject({ limit: null, remaining: null });
    expect(await entitlements.clearLimit("org-1", "seats")).toMatchObject({ limit: 3, source: "default" });
    await expect(entitlements.setLimit("org-1", "seats", -1)).rejects.toMatchObject({ code: "entitlement_limit_invalid" });
    await expect(entitlements.setLimit("ghost", "seats", 1)).rejects.toMatchObject({ code: "entitlement_organization_unknown" });
    await expect(entitlements.get("org-1", "nope")).rejects.toMatchObject({ code: "entitlement_unknown" });
  });

  it("consume takes only what fits, release gives back, windows reset", async () => {
    const { entitlements } = await seed();
    expect(await entitlements.consume("org-1", "seats", 2)).toEqual({ allowed: true, used: 2, limit: 3, remaining: 1 });
    expect(await entitlements.consume("org-1", "seats", 2)).toMatchObject({ allowed: false, used: 2 });
    expect(await entitlements.release("org-1", "seats", 5)).toMatchObject({ used: 0 });
    await expect(entitlements.consume("org-1", "seats", 0)).rejects.toMatchObject({ code: "entitlement_amount_invalid" });
    expect(await entitlements.consume("org-1", "reports_per_month", 2, { now: day(0) })).toMatchObject({ allowed: true });
    expect(await entitlements.consume("org-1", "reports_per_month", 1, { now: day(1) })).toMatchObject({ allowed: false });
    expect(await entitlements.consume("org-1", "reports_per_month", 1, { now: day(20) })).toMatchObject({ allowed: true, used: 1 });
  });

  it("concurrent consumers never pass the limit; undefine removes limits and usage", async () => {
    const { entitlements } = await seed();
    await entitlements.setLimit("org-1", "seats", 5);
    const results = await Promise.all(Array.from({ length: 20 }, () => entitlements.consume("org-1", "seats")));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    await entitlements.undefine("seats");
    await entitlements.define({ key: "seats", defaultLimit: 3 });
    expect(await entitlements.get("org-1", "seats")).toMatchObject({ used: 0, source: "default" });
  });
});
