import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { FeatureError } from "./repository.js";

const actor = { provider: "p", subject: "operator" };

async function setup() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org-1", name: "Uno" });
  await storage.organizations.create({ id: "org-2", name: "Dos" });
  return storage;
}

describe("features: valor por defecto", () => {
  it("una función con defaultEnabled nace activa para todas las organizaciones, sin filas", async () => {
    const storage = await setup();
    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await storage.features.register({ key: "reports", name: "Reports" });

    expect(await storage.features.isEnabled("org-1", "agenda")).toBe(true);
    expect(await storage.features.isEnabled("org-2", "agenda")).toBe(true);
    expect(await storage.features.isEnabled("org-1", "reports")).toBe(false);
    expect(await storage.features.enabledKeys("org-1", ["agenda", "reports", "ghost"])).toEqual(["agenda"]);
    expect(await storage.features.listByOrganization("org-1")).toEqual([]);
  });

  it("un override explícito gana sobre el valor por defecto, en los dos sentidos", async () => {
    const storage = await setup();
    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await storage.features.register({ key: "reports", name: "Reports" });

    await storage.features.disable("org-1", "agenda");
    await storage.features.enable("org-1", "reports");

    expect(await storage.features.isEnabled("org-1", "agenda")).toBe(false);
    expect(await storage.features.isEnabled("org-2", "agenda")).toBe(true);
    expect(await storage.features.isEnabled("org-1", "reports")).toBe(true);
  });

  it("access.check y los snapshots respetan el valor por defecto", async () => {
    const { createAuthorizationEngine, computeAuthorizationSnapshot } = await import("../index.js");
    const storage = await setup();
    const owner = await storage.roles.createOwnerRole({ id: "r", organizationId: "org-1" });
    const me = { provider: "p", subject: "me" };
    const membership = await storage.memberships.create({ id: "m", organizationId: "org-1", identity: me });
    await storage.memberships.assignOwnerRole(membership.id, owner.id);
    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await storage.features.register({ key: "reports", name: "Reports" });
    const engine = createAuthorizationEngine(storage);

    expect(await engine.access.check({ identity: me, organizationId: "org-1", feature: "agenda" })).toBe(true);
    expect(await engine.access.check({ identity: me, organizationId: "org-1", feature: "reports" })).toBe(false);
    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity: me,
      organizationId: "org-1",
      features: ["agenda", "reports"],
    });
    expect(snapshot.features).toEqual({ agenda: true, reports: false });
  });
});

describe("features: jerarquía", () => {
  async function tree() {
    const storage = await setup();
    await storage.features.register({ key: "workspace", name: "Workspace", defaultEnabled: true });
    await storage.features.register({ key: "workspace_chat", name: "Chat", defaultEnabled: true, parentKey: "workspace" });
    await storage.features.register({ key: "workspace_files", name: "Files", parentKey: "workspace" });
    return storage;
  }

  it("apagar el padre apaga a los hijos, y el motivo lo dice", async () => {
    const storage = await tree();
    await storage.features.enable("org-1", "workspace_files");
    expect(await storage.features.isEnabled("org-1", "workspace_chat")).toBe(true);

    await storage.features.disable("org-1", "workspace", { actor, reason: "impago" });

    expect(await storage.features.isEnabled("org-1", "workspace_chat")).toBe(false);
    expect(await storage.features.isEnabled("org-1", "workspace_files")).toBe(false);
    const effective = await storage.features.listEffective("org-1");
    expect(effective.find((f) => f.key === "workspace_chat")).toMatchObject({ enabled: false, reason: "parent_disabled", blockedBy: "workspace" });
    expect(effective.find((f) => f.key === "workspace_files")).toMatchObject({ enabled: false, reason: "parent_disabled" });
    expect(effective.find((f) => f.key === "workspace")).toMatchObject({
      enabled: false,
      reason: "disabled",
      override: { enabled: false, reason: "impago", updatedBy: actor },
    });
    // La otra organización no se ve afectada.
    expect(await storage.features.isEnabled("org-2", "workspace_chat")).toBe(true);
  });

  it("listEffective explica cada estado: enabled, disabled, default y parent_disabled", async () => {
    const storage = await tree();
    await storage.features.enable("org-1", "workspace_files");
    await storage.features.disable("org-1", "workspace_chat");
    const byKey = Object.fromEntries((await storage.features.listEffective("org-1")).map((f) => [f.key, f.reason]));
    expect(byKey).toEqual({ workspace: "default", workspace_chat: "disabled", workspace_files: "enabled" });
    expect((await storage.features.listEffective("org-1", { keys: ["workspace"] })).map((f) => f.key)).toEqual(["workspace"]);
  });

  it("rechaza padres desconocidos, a sí mismo, ciclos y cadenas demasiado profundas", async () => {
    const storage = await tree();
    await expect(storage.features.register({ key: "orphan", name: "Orphan", parentKey: "ghost" })).rejects.toMatchObject({ code: "feature_parent_invalid" });
    await expect(storage.features.register({ key: "workspace", name: "W", parentKey: "workspace" })).rejects.toMatchObject({ code: "feature_parent_invalid" });
    await expect(storage.features.register({ key: "workspace", name: "W", parentKey: "workspace_chat" })).rejects.toMatchObject({ code: "feature_parent_invalid" });

    let parent: string | undefined = "workspace";
    for (let level = 0; level < 7; level++) {
      const key: string = `deep_${level}`;
      await storage.features.register({ key, name: key, parentKey: parent });
      parent = key;
    }
    await expect(storage.features.register({ key: "too_deep", name: "x", parentKey: parent })).rejects.toBeInstanceOf(FeatureError);
  });

  it("no se puede desregistrar un padre con hijos", async () => {
    const storage = await tree();
    await expect(storage.features.unregister("workspace")).rejects.toMatchObject({ code: "feature_has_children" });
  });

  it("el uso agregado y los filtros cuentan el estado efectivo", async () => {
    const storage = await tree();
    await storage.features.disable("org-1", "workspace");
    expect(await storage.features.countEnabledByOrganization(["org-1", "org-2"])).toEqual({ "org-1": 0, "org-2": 2 });
    expect((await storage.features.summarizeUsage(["workspace_chat", "workspace_files"], 5))).toEqual({
      workspace_chat: { enabledCount: 1, sampleOrganizationIds: ["org-2"] },
      workspace_files: { enabledCount: 0, sampleOrganizationIds: [] },
    });
    expect((await storage.features.search({ enabledIn: "org-2" })).map((f) => f.key)).toEqual(["workspace", "workspace_chat"]);
    expect(await storage.features.count({ enabledIn: "org-1" })).toBe(0);
  });
});

describe("features: operaciones masivas y metadatos", () => {
  it("setMany aplica todo o nada y registra quién, cuándo y por qué", async () => {
    const storage = await setup();
    await storage.features.register({ key: "a", name: "A" });
    await storage.features.register({ key: "b", name: "B", defaultEnabled: true });

    await expect(storage.features.setMany("org-1", { a: true, ghost: true })).rejects.toMatchObject({ code: "feature_unknown" });
    expect(await storage.features.isEnabled("org-1", "a")).toBe(false);

    const before = Date.now();
    await storage.features.setMany("org-1", { a: true, b: false }, { actor, reason: "  plan Pro  " });
    expect(await storage.features.isEnabled("org-1", "a")).toBe(true);
    expect(await storage.features.isEnabled("org-1", "b")).toBe(false);
    const rows = await storage.features.listByOrganization("org-1");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ updatedBy: actor, reason: "plan Pro" });
      expect(row.updatedAt!.getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("disableEverywhere apaga la función en todas las organizaciones, también donde no había fila", async () => {
    const storage = await setup();
    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await storage.features.enable("org-1", "agenda");
    expect(await storage.features.disableEverywhere("agenda", { actor, reason: "incidente" })).toEqual({
      disabledOverrides: 1,
      defaultWasEnabled: true,
    });
    expect(await storage.features.isEnabled("org-1", "agenda")).toBe(false);
    expect(await storage.features.isEnabled("org-2", "agenda")).toBe(false);
    expect((await storage.features.listByOrganization("org-1"))[0]).toMatchObject({ enabled: false, reason: "incidente", updatedBy: actor });
    await expect(storage.features.disableEverywhere("ghost")).rejects.toMatchObject({ code: "feature_unknown" });
    // Ya apagada en todas partes: se puede desregistrar.
    await storage.features.unregister("agenda");
  });

  it("no se puede desregistrar una función activa por defecto hasta apagarla", async () => {
    const storage = await setup();
    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await expect(storage.features.unregister("agenda")).rejects.toMatchObject({ code: "feature_in_use" });
  });
});
