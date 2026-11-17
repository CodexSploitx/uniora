import { describe, expect, it } from "vitest";
import { createAuditedStorage, createMemoryStorage, retireFeature } from "../index.js";

const actor = { provider: "main", subject: "operator" };

describe("retireFeature", () => {
  it("audits the kill switch and the removal when the storage is audited", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditedStorage(raw, { actor });
    const org = await storage.organizations.create({ id: "org", name: "Acme" });
    await storage.features.register({ key: "legacy", name: "Legacy" });
    await storage.features.enable(org.id, "legacy");
    await retireFeature(storage, "legacy", { disableEverywhere: true, reason: "Retired" });
    const actions = (await raw.auditLogs.search()).map((entry) => entry.action);
    expect(actions).toContain("feature.disabled_everywhere");
    expect(actions).toContain("feature.unregistered");
  });

  it("does nothing, and audits nothing, for a key that is already gone", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditedStorage(raw, { actor });
    const before = (await raw.auditLogs.search()).length;
    expect(await retireFeature(storage, "never-existed")).toEqual({ retired: false, disabledOverrides: 0, defaultWasEnabled: false });
    expect((await raw.auditLogs.search()).length).toBe(before);
  });
});
