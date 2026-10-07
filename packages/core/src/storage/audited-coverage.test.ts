import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, createAuditedStorage, isStandardAuditAction } from "../index.js";
import { createMemoryStorage } from "./memory.js";

const actor = { provider: "p", subject: "operator" };

/** Methods that only read (or are deliberately not audited). Anything else a repository exposes must be audited. */
const READ_ONLY = /^(find|list|search|count|is[A-Z]|enabledKeys$|summarizeUsage$|granting|granted|get|resolve|verify)/;
/** Deliberately not audited: a heartbeat, not a change. */
const NOT_AUDITED = new Set(["memberships.recordActivity"]);
/** Audited by their own service/repository rather than by the wrapper (they already record themselves). */
const SELF_AUDITING = new Set(["auditLogs", "invitations", "identityLinks"]);

describe("createAuditedStorage: every mutation is audited, with standard names", () => {
  it("wraps every mutating method of every repository (a new mutator can't slip through unaudited)", () => {
    const raw = createMemoryStorage();
    const audited = createAuditedStorage(raw, { actor });
    const unwrapped: string[] = [];
    for (const repository of ["organizations", "memberships", "roles", "permissions", "features"] as const) {
      for (const method of Object.keys(raw[repository])) {
        const name = `${repository}.${method}`;
        if (READ_ONLY.test(method) || NOT_AUDITED.has(name)) continue;
        if ((audited[repository] as Record<string, unknown>)[method] === (raw[repository] as Record<string, unknown>)[method]) unwrapped.push(name);
      }
    }
    expect(unwrapped).toEqual([]);
    expect([...SELF_AUDITING]).toEqual(["auditLogs", "invitations", "identityLinks"]);
  });

  it("only records action names from the standard catalog, each with the actor", async () => {
    const raw = createMemoryStorage();
    const audited = createAuditedStorage(raw, { actor });
    await audited.organizations.create({ id: "org", name: "Acme" });
    await audited.organizations.rename("org", "Acme 2");
    await audited.organizations.update("org", { name: "Acme 3", slug: "acme-3" });
    await audited.organizations.setStatus("org", { status: "suspended", actor, reason: "unpaid" });
    await audited.organizations.setStatus("org", { status: "active", actor });
    await audited.permissions.register({ key: "reports.read" });
    await audited.features.register({ key: "agenda", name: "Agenda" });
    await audited.features.register({ key: "agenda_chat", name: "Chat", parentKey: "agenda" });
    await audited.features.enable("org", "agenda");
    await audited.features.disable("org", "agenda");
    await audited.features.setMany("org", { agenda: true });
    await audited.features.disableEverywhere("agenda");
    const owner = await audited.roles.createOwnerRole({ id: "owner", organizationId: "org" });
    const staff = await audited.roles.create({ id: "staff", organizationId: "org", name: "Staff" });
    await audited.roles.grantPermission(staff.id, "reports.read");
    await audited.roles.revokePermission(staff.id, "reports.read");
    await audited.roles.rename(staff.id, "Staff 2");
    const a = await audited.memberships.create({ id: "m-a", organizationId: "org", identity: { provider: "p", subject: "a" } });
    const b = await audited.memberships.create({ id: "m-b", organizationId: "org", identity: { provider: "p", subject: "b" } });
    await audited.memberships.assignOwnerRole(a.id, owner.id);
    await audited.memberships.assignOwnerRole(b.id, owner.id);
    await audited.memberships.assignRole(a.id, staff.id);
    await audited.memberships.unassignRole(a.id, staff.id);
    await audited.memberships.block(b.id, { actor });
    await audited.memberships.unblock(b.id, { actor });
    await audited.memberships.unassignOwnerRole(b.id, owner.id);
    await audited.memberships.delete(b.id);
    await audited.roles.delete(staff.id);
    await audited.features.unregister("agenda_chat");
    await audited.features.unregister("agenda");
    await audited.permissions.unregister("reports.read");

    const entries = await raw.auditLogs.search();
    expect(entries.length).toBeGreaterThanOrEqual(20);
    for (const entry of entries) {
      expect(isStandardAuditAction(entry.action), entry.action).toBe(true);
      expect(entry.actor).toEqual(actor);
    }
    // Every standard action the wrapper can emit was exercised at least once, none is orphaned from the catalog.
    const emitted = new Set(entries.map((entry) => entry.action));
    for (const action of AUDIT_ACTIONS) {
      if (action.startsWith("invitation.") || action.startsWith("identity_link.") || action === "membership.left" || action === "audit_log.pruned" || action === "organization.ownership_transferred") continue;
      expect(emitted.has(action), `${action} is in the catalog but never emitted`).toBe(true);
    }
  });
});

describe("AuditLogRepository.search (memory)", () => {
  it("filters by action, prefix, actor, target and time like the SQL backends", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org", name: "Acme" });
    const other = { provider: "p", subject: "other" };
    await storage.auditLogs.record({ id: "1", organizationId: "org", actor, action: "membership.blocked", target: { type: "membership", id: "m" } });
    await storage.auditLogs.record({ id: "2", organizationId: "org", actor: other, action: "feature.disabled", target: { type: "feature", id: "f" } });
    expect((await storage.auditLogs.search({ actionPrefix: "membership." })).map((e) => e.id)).toEqual(["1"]);
    expect((await storage.auditLogs.search({ actor: other })).map((e) => e.id)).toEqual(["2"]);
    expect((await storage.auditLogs.search({ target: { type: "feature" } })).map((e) => e.id)).toEqual(["2"]);
    expect(await storage.auditLogs.search({ until: new Date(0) })).toEqual([]);
    await expect(storage.auditLogs.record({ id: "3", actor: { provider: "", subject: "" }, action: "x.y" })).rejects.toMatchObject({ code: "audit_actor_required" });
  });
});
