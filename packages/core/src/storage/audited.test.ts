import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./memory.js";
import { createAuditedStorage } from "./audited.js";

const operator = { provider: "studio", subject: "operator-1" };

describe("createAuditedStorage (audit F-05)", () => {
  it("records a chained audit entry for every core mutation, attributed to the operator", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditedStorage(raw, { actor: operator });

    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.rename("org-1", "Acme 2");
    await storage.permissions.register({ key: "posts.edit", description: "Edit" });
    await storage.roles.create({ id: "role-1", organizationId: "org-1", name: "Editor" });
    await storage.roles.grantPermission("role-1", "posts.edit");
    await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity: { provider: "x", subject: "u" } });
    await storage.memberships.assignRole("m-1", "role-1");
    await storage.memberships.unassignRole("m-1", "role-1");
    await storage.roles.revokePermission("role-1", "posts.edit");
    await storage.features.enable("org-1", "beta").catch(() => undefined);
    await storage.roles.delete("role-1");
    await storage.memberships.delete("m-1");

    const entries = (await raw.auditLogs.listRecent()).reverse();
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "organization.created",
        "organization.renamed",
        "permission.registered",
        "role.created",
        "role.permission_granted",
        "membership.created",
        "membership.role_assigned",
        "membership.role_unassigned",
        "role.permission_revoked",
        "role.deleted",
        "membership.deleted",
      ]),
    );
    expect(entries.every((e) => e.actor.subject === "operator-1")).toBe(true);
    expect(entries.find((e) => e.action === "role.deleted")?.organizationId).toBe("org-1");
    expect(await raw.auditLogs.verifyIntegrity()).toMatchObject({ ok: true });
  });

  it("does not record anything when the mutation fails", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditedStorage(raw, { actor: operator });
    await expect(storage.roles.delete("does-not-exist")).rejects.toThrow();
    expect(await raw.auditLogs.listRecent()).toHaveLength(0);
  });

  it("reads pass through without auditing", async () => {
    const raw = createMemoryStorage();
    const storage = createAuditedStorage(raw, { actor: operator });
    await storage.organizations.list();
    expect(await raw.auditLogs.listRecent()).toHaveLength(0);
  });
});
