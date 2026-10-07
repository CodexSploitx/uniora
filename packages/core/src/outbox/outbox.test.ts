import { beforeEach, describe, expect, it } from "vitest";
import { createAuditedStorage } from "../storage/audited.js";
import { createMemoryStorage } from "../storage/memory.js";
import { dispatchOutbox, outboxBackoffSeconds } from "./dispatch.js";

const actor = { provider: "p", subject: "operator" };
// A moment just after "now", so events enqueued by the test are already due at at(0).
let base = Date.now() + 1000;
beforeEach(() => {
  base = Date.now() + 1000;
});
const at = (seconds: number) => new Date(base + seconds * 1000);

describe("outbox (memory)", () => {
  it("enqueues in order, validates, and rejects a repeated id", async () => {
    const { outbox } = createMemoryStorage();
    const first = await outbox.enqueue({ id: "e1", type: "member.blocked", organizationId: "org-1", payload: { who: "a" } });
    const second = await outbox.enqueue({ id: "e2", type: "member.unblocked" });
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first).toMatchObject({ status: "pending", attempts: 0, payload: { who: "a" } });
    await expect(outbox.enqueue({ id: "e1", type: "x" })).rejects.toMatchObject({ code: "outbox_event_exists" });
    await expect(outbox.enqueue({ id: "", type: "x" })).rejects.toMatchObject({ code: "outbox_event_invalid" });
    await expect(outbox.enqueue({ id: "e3", type: "" })).rejects.toMatchObject({ code: "outbox_event_invalid" });
    await expect(outbox.enqueue({ id: "e3", type: "t", payload: { big: "x".repeat(17 * 1024) } })).rejects.toMatchObject({ code: "outbox_payload_invalid" });
    await expect(outbox.enqueue({ id: "e3", type: "t", payload: [] as never })).rejects.toMatchObject({ code: "outbox_payload_invalid" });
  });

  it("claim leases events: nobody else gets them until the lease expires; attempts count claims", async () => {
    const { outbox } = createMemoryStorage();
    for (const id of ["e1", "e2", "e3"]) await outbox.enqueue({ id, type: "t" });
    const mine = await outbox.claim({ limit: 2, leaseSeconds: 30, now: at(0) });
    expect(mine.map((event) => event.id)).toEqual(["e1", "e2"]);
    expect(mine.every((event) => event.attempts === 1)).toBe(true);
    expect((await outbox.claim({ now: at(10) })).map((event) => event.id)).toEqual(["e3"]);
    expect(await outbox.claim({ now: at(20) })).toEqual([]);
    const again = await outbox.claim({ now: at(31) });
    expect(again.map((event) => event.id)).toEqual(["e1", "e2"]);
    expect(again.every((event) => event.attempts === 2)).toBe(true);
    await expect(outbox.claim({ limit: 0 })).rejects.toMatchObject({ code: "outbox_claim_invalid" });
    await expect(outbox.claim({ leaseSeconds: 0 })).rejects.toMatchObject({ code: "outbox_claim_invalid" });
  });

  it("complete, fail with retry, dead after maxAttempts, requeue and prune", async () => {
    const { outbox } = createMemoryStorage();
    await outbox.enqueue({ id: "e1", type: "t" });
    await outbox.enqueue({ id: "e2", type: "t" });
    await outbox.claim({ now: at(0) });
    expect(await outbox.complete(["e1", "e1", "nope"], at(1))).toBe(1);
    expect(await outbox.complete(["e1"], at(2))).toBe(0);
    expect(await outbox.fail("e2", { error: "boom", retryAt: at(60), maxAttempts: 2 })).toBe("pending");
    expect(await outbox.claim({ now: at(30) })).toEqual([]);
    const retry = await outbox.claim({ now: at(61) });
    expect(retry).toMatchObject([{ id: "e2", attempts: 2, lastError: "boom" }]);
    expect(await outbox.fail("e2", { error: "boom again", retryAt: at(120), maxAttempts: 2 })).toBe("dead");
    expect(await outbox.fail("e2", { error: "x", retryAt: at(0), maxAttempts: 2 })).toBeNull();
    expect(await outbox.claim({ now: at(500) })).toEqual([]);
    expect((await outbox.search({ status: "dead" })).map((event) => event.id)).toEqual(["e2"]);
    expect(await outbox.requeue("e2", at(600))).toBe(true);
    expect(await outbox.requeue("e1", at(600))).toBe(false);
    expect(await outbox.findById("e2")).toMatchObject({ status: "pending", attempts: 0 });
    expect(await outbox.pruneDelivered(at(1))).toBe(0);
    expect(await outbox.pruneDelivered(at(3))).toBe(1);
    expect(await outbox.findById("e1")).toBeNull();
    expect(await outbox.count()).toBe(1);
  });

  it("dispatchOutbox delivers, retries with backoff, parks dead events and never stops the batch", async () => {
    const { outbox } = createMemoryStorage();
    for (const id of ["ok-1", "bad", "ok-2"]) await outbox.enqueue({ id, type: "t", payload: { id } });
    const seen: string[] = [];
    let clock = at(0);
    const run = (maxAttempts: number) =>
      dispatchOutbox(
        outbox,
        (event) => {
          seen.push(event.id);
          if (event.id === "bad") throw new Error("webhook https://hooks.example/secret-token failed");
        },
        { maxAttempts, backoffSeconds: 10, secrets: ["secret-token"], now: () => clock },
      );
    expect(await run(2)).toEqual({ claimed: 3, delivered: 2, retried: 1, dead: 0 });
    expect(seen).toEqual(["ok-1", "bad", "ok-2"]);
    const bad = await outbox.findById("bad");
    expect(bad?.lastError).toContain("[redacted]");
    expect(bad?.lastError).not.toContain("secret-token");
    expect(bad?.availableAt.getTime()).toBe(at(10).getTime());
    clock = at(11);
    expect(await run(2)).toEqual({ claimed: 1, delivered: 0, retried: 0, dead: 1 });
    expect((await outbox.findById("bad"))?.status).toBe("dead");
    expect(await run(2)).toEqual({ claimed: 0, delivered: 0, retried: 0, dead: 0 });
    expect([outboxBackoffSeconds(1, 30), outboxBackoffSeconds(2, 30), outboxBackoffSeconds(3, 30), outboxBackoffSeconds(20, 30, 3600)]).toEqual([30, 60, 120, 3600]);
  });

  it("an audited storage with outbox enqueues one event per audited change, with the audit action as type", async () => {
    const raw = createMemoryStorage();
    const audited = createAuditedStorage(raw, { actor, outbox: true });
    await audited.organizations.create({ id: "org", name: "Acme" });
    await audited.permissions.register({ key: "reports.read" });
    const events = await raw.outbox.search();
    expect(events.map((event) => event.type)).toEqual(["organization.created", "permission.registered"]);
    expect(events[0]).toMatchObject({ organizationId: "org", payload: { actor, target: { type: "organization", id: "org" }, metadata: { name: "Acme" } } });
    expect(await raw.auditLogs.search({ organizationId: "org" })).toHaveLength(1);

    const quiet = createMemoryStorage();
    await createAuditedStorage(quiet, { actor }).organizations.create({ id: "org", name: "Acme" });
    expect(await quiet.outbox.count()).toBe(0);
  });
});
