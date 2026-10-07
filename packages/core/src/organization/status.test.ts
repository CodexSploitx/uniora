import { describe, expect, it } from "vitest";
import { createAuthorizationEngine } from "../authorization/engine.js";
import { computeAuthorizationSnapshot } from "../authorization/snapshot.js";
import { createMemoryStorage } from "../storage/memory.js";

const operator = { provider: "p", subject: "operator" };
const staff = { provider: "p", subject: "staff" };

async function seed() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org-1", name: "Acme" });
  await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
  await storage.roles.create({ id: "role-staff", organizationId: "org-1", name: "Staff", permissionKeys: ["reports.read"] });
  await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity: staff, roleIds: ["role-staff"] });
  return storage;
}

describe("organization status (memory)", () => {
  it("tracks who, when and why, and ignores a repeat of the same status", async () => {
    const storage = await seed();
    const first = await storage.organizations.setStatus("org-1", { status: "suspended", actor: operator, reason: " unpaid " });
    expect(first).toMatchObject({ status: "suspended", statusChange: { by: operator, reason: "unpaid" } });
    const repeat = await storage.organizations.setStatus("org-1", { status: "suspended", actor: staff, reason: "other" });
    expect(repeat?.statusChange).toMatchObject({ by: operator, reason: "unpaid" });
    expect(await storage.organizations.setStatus("ghost", { status: "archived", actor: operator })).toBeNull();
    await expect(storage.organizations.setStatus("org-1", { status: "gone" as never, actor: operator })).rejects.toMatchObject({
      code: "organization_status_invalid",
    });
  });

  it("denies can, access.check and snapshots while the organization is not active, and restores them after", async () => {
    const storage = await seed();
    const engine = createAuthorizationEngine(storage);
    const snapshot = () =>
      computeAuthorizationSnapshot(engine, storage.features, {
        identity: staff,
        organizationId: "org-1",
        permissions: ["reports.read"],
        features: ["agenda"],
      });
    expect(await snapshot()).toMatchObject({ permissions: { "reports.read": true }, features: { agenda: true } });

    await storage.organizations.setStatus("org-1", { status: "archived", actor: operator });
    expect(await engine.can({ identity: staff, organizationId: "org-1", permission: "reports.read" })).toBe(false);
    expect(await engine.access.check({ identity: staff, organizationId: "org-1", feature: "agenda" })).toBe(false);
    expect(await snapshot()).toMatchObject({ permissions: { "reports.read": false }, features: { agenda: false } });

    await storage.organizations.setStatus("org-1", { status: "active", actor: operator });
    expect(await snapshot()).toMatchObject({ permissions: { "reports.read": true }, features: { agenda: true } });
  });

  it("an organization the storage doesn't know denies everything (fail closed)", async () => {
    const storage = createMemoryStorage();
    await storage.roles.create({ id: "role-staff", organizationId: "ghost", name: "Staff", permissionKeys: ["reports.read"] });
    await storage.memberships.create({ id: "m-1", organizationId: "ghost", identity: staff, roleIds: ["role-staff"] });
    const engine = createAuthorizationEngine(storage);
    expect(await engine.can({ identity: staff, organizationId: "ghost", permission: "reports.read" })).toBe(false);
    expect(await engine.access.check({ identity: staff, organizationId: "ghost" })).toBe(false);
  });

  it("update changes name and slug, validates both, and refuses an empty update or a taken slug", async () => {
    const storage = await seed();
    await storage.organizations.create({ id: "org-2", name: "Otra", slug: "otra" });
    expect(await storage.organizations.update("org-1", { name: "Acme 2", slug: "acme-2" })).toMatchObject({ name: "Acme 2", slug: "acme-2" });
    expect(await storage.organizations.update("ghost", { name: "X" })).toBeNull();
    await expect(storage.organizations.update("org-1", {})).rejects.toMatchObject({ code: "organization_update_empty" });
    await expect(storage.organizations.update("org-1", { slug: "otra" })).rejects.toMatchObject({ code: "organization_slug_taken" });
    await expect(storage.organizations.update("org-1", { slug: "No Good" })).rejects.toMatchObject({ code: "organization_slug_invalid" });
  });

  it("search and count filter by status", async () => {
    const storage = await seed();
    await storage.organizations.create({ id: "org-2", name: "Otra" });
    await storage.organizations.setStatus("org-2", { status: "archived", actor: operator });
    expect((await storage.organizations.search({ status: "archived" })).map((o) => o.id)).toEqual(["org-2"]);
    expect(await storage.organizations.count({ status: ["active", "archived"] })).toBe(2);
    expect(await storage.organizations.count({ status: "suspended" })).toBe(0);
  });

  it("search({ feature }) and features.listEffectiveMany use the effective state (default, override, parents)", async () => {
    const storage = createMemoryStorage();
    for (const id of ["o1", "o2", "o3"]) {
      await storage.organizations.create({ id, name: `Org ${id}` });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await storage.features.register({ key: "agenda_files", name: "Files", parentKey: "agenda" });
    await storage.features.disable("o2", "agenda");
    await storage.features.enable("o2", "agenda_files");
    await storage.features.enable("o3", "agenda_files");
    const ids = (list: Array<{ id: string }>) => list.map((o) => o.id);
    expect(ids(await storage.organizations.search({ feature: { key: "agenda" } }))).toEqual(["o1", "o3"]);
    expect(ids(await storage.organizations.search({ feature: { key: "agenda_files" } }))).toEqual(["o3"]);
    expect(ids(await storage.organizations.search({ feature: { key: "agenda_files", enabled: false } }))).toEqual(["o1", "o2"]);
    expect(await storage.organizations.count({ feature: { key: "nope" } })).toBe(0);

    const many = await storage.features.listEffectiveMany(["o1", "o2"], { keys: ["agenda_files"] });
    expect(many.o2?.[0]).toMatchObject({ enabled: false, reason: "parent_disabled" });
    await expect(storage.features.listEffectiveMany(Array.from({ length: 501 }, (_, n) => `x${n}`))).rejects.toMatchObject({
      code: "feature_invalid",
    });
  });
});
