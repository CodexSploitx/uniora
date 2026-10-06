import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { applyAuditRetention, MIN_AUDIT_RETENTION_DAYS } from "./retention.js";

const actor = { provider: "supabase", subject: "retention-job" };
const pause = () => new Promise((resolve) => setTimeout(resolve, 8));

describe("audit retention (memory)", () => {
  it("prunes a prefix, keeps the chain verifiable from the checkpoint and keeps positions stable", async () => {
    const { auditLogs } = createMemoryStorage();
    for (const id of ["o1", "o2", "o3"]) await auditLogs.record({ id, actor, action: "role.created" });
    await pause();
    const cutoff = new Date();
    await pause();
    for (const id of ["n1", "n2"]) await auditLogs.record({ id, actor, action: "role.updated" });
    const { head } = await auditLogs.verifyIntegrity();

    const result = await auditLogs.pruneBefore({ before: cutoff, actor });
    expect(result.removed).toBe(3);
    expect(result.through?.position).toBe(3);

    const report = await auditLogs.verifyIntegrity();
    expect(report).toMatchObject({ ok: true, checked: 3, pruned: { removed: 3, through: result.through } });
    expect(report.head?.position).toBe((head?.position ?? 0) + 1);
    expect(await auditLogs.verifyIntegrity({ anchor: head! })).toMatchObject({ ok: true, anchor: "valid" });
    expect(await auditLogs.verifyIntegrity({ anchor: { position: 2, hash: "x" } })).toMatchObject({ ok: true, anchor: "pruned" });
    expect(await auditLogs.search({ action: "audit_log.pruned" })).toHaveLength(1);

    await auditLogs.record({ id: "late", actor, action: "role.created" });
    expect(await auditLogs.verifyIntegrity()).toMatchObject({ ok: true, checked: 4 });
  });

  it("never removes the newest entry and rejects a future cut-off", async () => {
    const { auditLogs } = createMemoryStorage();
    for (const id of ["a", "b"]) await auditLogs.record({ id, actor, action: "role.created" });
    await pause();
    await expect(auditLogs.pruneBefore({ before: new Date(Date.now() + 60_000), actor })).rejects.toMatchObject({
      code: "audit_prune_invalid",
    });
    expect((await auditLogs.pruneBefore({ before: new Date(), actor })).removed).toBe(1);
    expect((await auditLogs.search({ action: "role.created" })).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("applyAuditRetention refuses to keep less than the minimum and removes nothing recent", async () => {
    const storage = createMemoryStorage();
    await storage.auditLogs.record({ id: "a", actor, action: "role.created" });
    await expect(applyAuditRetention(storage, { keep: { days: MIN_AUDIT_RETENTION_DAYS - 1 }, actor })).rejects.toMatchObject({
      code: "audit_prune_invalid",
    });
    const result = await applyAuditRetention(storage, { keep: { years: 5 }, actor });
    expect(result.removed).toBe(0);
    expect(result.before.getTime()).toBeLessThan(Date.now() - 5 * 365 * 86_400_000);
  });
});
