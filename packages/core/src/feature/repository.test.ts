import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { FeatureError } from "./repository.js";

describe("FeatureRepository", () => {
  it("register() deriva un key a partir del nombre cuando no se pasa uno explícito", async () => {
    const storage = createMemoryStorage();

    const definition = await storage.features.register({ name: "Advanced Reports" });

    expect(definition).toEqual({ key: "advanced_reports", name: "Advanced Reports", description: undefined });
  });

  it("register() acepta un key explícito distinto del derivado del nombre", async () => {
    const storage = createMemoryStorage();

    const definition = await storage.features.register({ name: "Advanced Reports", key: "reports_v2" });

    expect(definition.key).toBe("reports_v2");
  });

  it("register() rechaza un key explícito mal formado", async () => {
    const storage = createMemoryStorage();

    await expect(storage.features.register({ name: "Advanced Reports", key: "Not Valid" })).rejects.toThrow(
      FeatureError,
    );
  });

  it("register() es un upsert idempotente: re-registrar el mismo key actualiza su definición", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });

    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports v2", description: "..." });

    const [definition] = await storage.features.listCatalog();
    expect(definition).toEqual({ key: "advanced_reports", name: "Advanced Reports v2", description: "..." });
  });

  it("rechaza enable()/disable() de un key nunca registrado (fail-closed)", async () => {
    const storage = createMemoryStorage();

    await expect(storage.features.enable("org-1", "never_registered")).rejects.toThrow(FeatureError);
    await expect(storage.features.disable("org-1", "never_registered")).rejects.toThrow(FeatureError);
  });

  it("permite enable()/disable() una vez registrado el key", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });

    await storage.features.enable("org-1", "advanced_reports");
    expect(await storage.features.isEnabled("org-1", "advanced_reports")).toBe(true);

    await storage.features.disable("org-1", "advanced_reports");
    expect(await storage.features.isEnabled("org-1", "advanced_reports")).toBe(false);
  });

  it("isEnabled() de un key nunca habilitado (aunque registrado) es false, sin lanzar", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });

    expect(await storage.features.isEnabled("org-1", "advanced_reports")).toBe(false);
  });

  it("listCatalog() lista todas las definiciones registradas, sin importar organización", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
    await storage.features.register({ key: "ai_assistant", name: "AI Assistant" });

    const catalog = await storage.features.listCatalog();
    expect(catalog.map((f) => f.key).sort()).toEqual(["advanced_reports", "ai_assistant"]);
  });

  it("listByOrganization() aísla los toggles por organización", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
    await storage.features.enable("org-1", "advanced_reports");

    expect(await storage.features.listByOrganization("org-1")).toHaveLength(1);
    expect(await storage.features.listByOrganization("org-2")).toHaveLength(0);
  });

  it("unregister() rechaza un key nunca registrado", async () => {
    const storage = createMemoryStorage();

    await expect(storage.features.unregister("advanced_reports")).rejects.toThrow(FeatureError);
  });

  it("unregister() rechaza un feature todavía habilitado en alguna organización (cross-tenant blast radius)", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
    await storage.features.enable("org-1", "advanced_reports");

    await expect(storage.features.unregister("advanced_reports")).rejects.toThrow(FeatureError);

    expect(await storage.features.listCatalog()).toContainEqual(
      expect.objectContaining({ key: "advanced_reports" }),
    );
  });

  it("unregister() elimina el catálogo y los toggles deshabilitados una vez que nadie lo tiene habilitado", async () => {
    const storage = createMemoryStorage();
    await storage.features.register({ key: "advanced_reports", name: "Advanced Reports" });
    await storage.features.enable("org-1", "advanced_reports");
    await storage.features.disable("org-1", "advanced_reports");

    await storage.features.unregister("advanced_reports");

    expect(await storage.features.listCatalog()).toEqual([]);
    expect(await storage.features.listByOrganization("org-1")).toEqual([]);
  });
  describe("search / count / summarizeUsage", () => {
    it("filtra por key o name, pagina con keyset sin huecos y cuenta", async () => {
      const storage = createMemoryStorage();
      await storage.features.register({ name: "Advanced reports", key: "advanced_reports" });
      for (let i = 0; i < 9; i++) await storage.features.register({ name: `Bulk ${i}` });

      await expect(storage.features.search({ query: "ADVANCED" })).resolves.toMatchObject([{ key: "advanced_reports" }]);
      await expect(storage.features.count()).resolves.toBe(10);
      await expect(storage.features.count({ query: "bulk" })).resolves.toBe(9);

      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 3; page++) {
        const results = await storage.features.search({ limit: 4, after });
        seen.push(...results.map((f) => f.key));
        const last = results.at(-1);
        if (!last) break;
        after = last.key;
      }
      expect(seen).toHaveLength(10);
      expect(new Set(seen).size).toBe(10);
    });

    it("summarizeUsage cuenta organizaciones con el feature habilitado y devuelve una muestra acotada", async () => {
      const storage = createMemoryStorage();
      await storage.features.register({ name: "Reports", key: "reports" });
      await storage.features.register({ name: "Unused", key: "unused" });
      for (const id of ["o1", "o2", "o3"]) await storage.organizations.create({ id, name: `Org ${id}` });
      for (const id of ["o1", "o2", "o3"]) await storage.features.enable(id, "reports");
      await storage.features.disable("o3", "reports");

      await expect(storage.features.summarizeUsage(["reports", "unused"], 1)).resolves.toEqual({
        reports: { enabledCount: 2, sampleOrganizationIds: ["o1"] },
        unused: { enabledCount: 0, sampleOrganizationIds: [] },
      });
    });
  });
});
