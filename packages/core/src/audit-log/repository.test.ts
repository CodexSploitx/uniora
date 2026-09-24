import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";

const identity = { provider: "supabase", subject: "user-1" };

describe("AuditLogRepository (createMemoryStorage)", () => {
  it("registra una entrada y la devuelve con createdAt", async () => {
    const storage = createMemoryStorage();

    const entry = await storage.auditLogs.record({
      id: "log-1",
      organizationId: "org-1",
      actor: identity,
      action: "organization.created",
      target: { type: "organization", id: "org-1" },
    });

    expect(entry.id).toBe("log-1");
    expect(entry.action).toBe("organization.created");
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("nunca mezcla el historial de auditoría entre organizaciones (INV-001)", async () => {
    const storage = createMemoryStorage();

    await storage.auditLogs.record({ id: "log-a", organizationId: "org-a", actor: identity, action: "role.created" });
    await storage.auditLogs.record({ id: "log-b", organizationId: "org-b", actor: identity, action: "role.created" });

    const orgA = await storage.auditLogs.listByOrganization("org-a");
    const orgB = await storage.auditLogs.listByOrganization("org-b");

    expect(orgA.map((e) => e.id)).toEqual(["log-a"]);
    expect(orgB.map((e) => e.id)).toEqual(["log-b"]);
  });

  it("lista del más reciente al más antiguo y respeta el límite", async () => {
    const storage = createMemoryStorage();

    for (const id of ["log-1", "log-2", "log-3"]) {
      await storage.auditLogs.record({ id, organizationId: "org-1", actor: identity, action: "feature.enabled" });
    }

    const all = await storage.auditLogs.listByOrganization("org-1");
    expect(all.map((e) => e.id)).toEqual(["log-3", "log-2", "log-1"]);

    const limited = await storage.auditLogs.listByOrganization("org-1", { limit: 2 });
    expect(limited.map((e) => e.id)).toEqual(["log-3", "log-2"]);
  });

  it("no expone ningún método para modificar o borrar una entrada ya registrada", async () => {
    const storage = createMemoryStorage();
    const keys = Object.keys(storage.auditLogs);

    expect(keys).toEqual(expect.arrayContaining(["record", "listByOrganization", "listRecent"]));
    expect(keys).not.toContain("update");
    expect(keys).not.toContain("delete");
  });

  describe("listRecent", () => {
    it("mezcla entradas de todas las organizaciones, de la más reciente a la más antigua", async () => {
      const storage = createMemoryStorage();
      await storage.auditLogs.record({ id: "log-a", organizationId: "org-a", actor: identity, action: "role.created" });
      await storage.auditLogs.record({ id: "log-b", organizationId: "org-b", actor: identity, action: "role.created" });
      await storage.auditLogs.record({ id: "log-c", organizationId: "org-a", actor: identity, action: "role.created" });

      const recent = await storage.auditLogs.listRecent();
      expect(recent.map((e) => e.id)).toEqual(["log-c", "log-b", "log-a"]);
    });

    it("respeta el límite", async () => {
      const storage = createMemoryStorage();
      for (const id of ["log-1", "log-2", "log-3"]) {
        await storage.auditLogs.record({ id, organizationId: "org-1", actor: identity, action: "feature.enabled" });
      }

      const limited = await storage.auditLogs.listRecent({ limit: 2 });
      expect(limited.map((e) => e.id)).toEqual(["log-3", "log-2"]);
    });

    it("pagina con `before` sin saltarse ni repetir entradas (keyset, no offset)", async () => {
      const storage = createMemoryStorage();
      for (const id of ["log-1", "log-2", "log-3", "log-4", "log-5"]) {
        await storage.auditLogs.record({ id, organizationId: "org-1", actor: identity, action: "feature.enabled" });
      }

      const firstPage = await storage.auditLogs.listRecent({ limit: 2 });
      expect(firstPage.map((e) => e.id)).toEqual(["log-5", "log-4"]);

      const lastOfFirstPage = firstPage[firstPage.length - 1];
      if (!lastOfFirstPage) throw new Error("expected a first page");
      const secondPage = await storage.auditLogs.listRecent({
        limit: 2,
        before: { createdAt: lastOfFirstPage.createdAt, id: lastOfFirstPage.id },
      });
      expect(secondPage.map((e) => e.id)).toEqual(["log-3", "log-2"]);

      const lastOfSecondPage = secondPage[secondPage.length - 1];
      if (!lastOfSecondPage) throw new Error("expected a second page");
      const thirdPage = await storage.auditLogs.listRecent({
        limit: 2,
        before: { createdAt: lastOfSecondPage.createdAt, id: lastOfSecondPage.id },
      });
      expect(thirdPage.map((e) => e.id)).toEqual(["log-1"]);
    });
  });
});
