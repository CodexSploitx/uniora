import { describe, expect, it } from "vitest";
import { createAuditContextStorage, createMemoryStorage } from "../index.js";

const actor = { provider: "main", subject: "ana" };

describe("createAuditContextStorage", () => {
  it("adds `via` to every audit entry, inside and outside a transaction, and keeps the chain valid", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditContextStorage(raw, { apiClientId: "apc_1", keyId: "key_1", requestId: "req_1" });
    await storage.auditLogs.record({ id: "a1", actor, action: "x.one", target: { type: "t", id: "1" } });
    await storage.transaction((tx) => tx.auditLogs.record({ id: "a2", actor, action: "x.two", target: { type: "t", id: "2" }, metadata: { reason: "r" } }));

    const entries = await raw.auditLogs.search();
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.metadata?.via).toEqual({ apiClientId: "apc_1", keyId: "key_1", requestId: "req_1" });
    expect(entries.find((entry) => entry.id === "a2")?.metadata).toMatchObject({ reason: "r" });
    expect((await raw.auditLogs.verifyIntegrity()).ok).toBe(true);
  });

  it("replaces a `via` the operation tried to set instead of trusting it", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditContextStorage(raw, { apiClientId: "apc_real" });
    await storage.auditLogs.record({ id: "a1", actor, action: "x.one", target: { type: "t", id: "1" }, metadata: { via: { apiClientId: "forged" } } });
    expect((await raw.auditLogs.search())[0]?.metadata?.via).toEqual({ apiClientId: "apc_real" });
  });

  it("leaves everything else untouched", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditContextStorage(raw, { requestId: "r" });
    await storage.organizations.create({ id: "org", name: "Acme" });
    expect((await raw.organizations.findById("org"))?.name).toBe("Acme");
    expect(await storage.transaction(async (tx) => (await tx.organizations.findById("org"))?.name)).toBe("Acme");
  });
});
