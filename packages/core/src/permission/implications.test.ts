import { describe, expect, it } from "vitest";
import { createAuthorizationEngine } from "../authorization/engine.js";
import { createMemoryStorage } from "../storage/memory.js";
import { createOrganizationWithOwner } from "../index.js";

const staff = { provider: "p", subject: "staff" };
const code = { code: "permission_implication_invalid" };

async function seed() {
  const storage = createMemoryStorage();
  await createOrganizationWithOwner(storage, {
    organizationId: "org-1",
    organizationName: "Acme",
    ownerRoleId: "role-owner",
    membershipId: "m-owner",
    ownerIdentity: { provider: "p", subject: "owner" },
  });
  await storage.permissions.register({ key: "appointments.read", group: "Agenda" });
  await storage.permissions.register({ key: "appointments.write", group: "Agenda", implies: ["appointments.read"] });
  await storage.permissions.register({ key: "appointments.admin", group: "Agenda", implies: ["appointments.write"] });
  await storage.permissions.register({ key: "reports.read", group: "Reportes" });
  return storage;
}

describe("permission groups and implications (memory)", () => {
  it("stores the group and the implications; re-registering without them clears them", async () => {
    const storage = await seed();
    expect(await storage.permissions.findByKey("appointments.write")).toMatchObject({ group: "Agenda", implies: ["appointments.read"] });
    await storage.permissions.register({ key: "appointments.write", group: "  Agenda  ", implies: ["appointments.read", "appointments.read"] });
    expect(await storage.permissions.findByKey("appointments.write")).toMatchObject({ group: "Agenda", implies: ["appointments.read"] });
    await storage.permissions.register({ key: "appointments.write" });
    const cleared = await storage.permissions.findByKey("appointments.write");
    expect(cleared?.group).toBeUndefined();
    expect(cleared?.implies ?? []).toEqual([]);
  });

  it("rejects unknown, self, cyclic, too deep and too many implications, and leaves the catalog untouched", async () => {
    const storage = await seed();
    await expect(storage.permissions.register({ key: "x.y", implies: ["nope.read"] })).rejects.toMatchObject(code);
    await expect(storage.permissions.register({ key: "x.y", implies: ["x.y"] })).rejects.toMatchObject(code);
    await expect(storage.permissions.register({ key: "appointments.read", implies: ["appointments.admin"] })).rejects.toMatchObject(code);
    expect(await storage.permissions.findByKey("x.y")).toBeNull();
    expect((await storage.permissions.findByKey("appointments.read"))?.implies ?? []).toEqual([]);

    let previous = "chain.p0";
    await storage.permissions.register({ key: previous });
    for (let level = 1; level <= 8; level += 1) {
      const key = `chain.p${level}`;
      await storage.permissions.register({ key, implies: [previous] });
      previous = key;
    }
    await expect(storage.permissions.register({ key: "chain.p9", implies: [previous] })).rejects.toMatchObject(code);

    for (let index = 0; index < 21; index += 1) await storage.permissions.register({ key: `many.p${index}` });
    await expect(
      storage.permissions.register({ key: "many.all", implies: Array.from({ length: 21 }, (_, index) => `many.p${index}`) }),
    ).rejects.toMatchObject(code);
    await expect(storage.permissions.register({ key: "x.y", group: "g".repeat(101) })).rejects.toMatchObject({ code: "permission_group_invalid" });
  });

  it("impliedBy and expand follow the whole chain", async () => {
    const storage = await seed();
    expect(await storage.permissions.impliedBy("appointments.read")).toEqual(["appointments.admin", "appointments.write"]);
    expect(await storage.permissions.impliedBy("appointments.admin")).toEqual([]);
    expect(await storage.permissions.expand(["appointments.admin"])).toEqual(["appointments.admin", "appointments.read", "appointments.write"]);
    expect(await storage.permissions.expand(["reports.read", "unknown.key"])).toEqual(["reports.read", "unknown.key"]);
  });

  it("can() passes for what a held permission implies, transitively, never the other way", async () => {
    const storage = await seed();
    await storage.roles.create({ id: "r-admin", organizationId: "org-1", name: "Admin", permissionKeys: ["appointments.admin"] });
    await storage.memberships.create({ id: "m-staff", organizationId: "org-1", identity: staff, roleIds: ["r-admin"] });
    const engine = createAuthorizationEngine(storage);
    const can = (permission: string) => engine.can({ identity: staff, organizationId: "org-1", permission });
    expect(await can("appointments.read")).toBe(true);
    expect(await can("appointments.write")).toBe(true);
    expect(await can("reports.read")).toBe(false);
    await storage.roles.setPermissions("r-admin", ["appointments.read"]);
    expect(await can("appointments.write")).toBe(false);
  });

  it("filters by group and refuses to unregister a permission another one implies", async () => {
    const storage = await seed();
    expect((await storage.permissions.search({ group: "Agenda" })).map((permission) => permission.key)).toEqual([
      "appointments.admin",
      "appointments.read",
      "appointments.write",
    ]);
    expect(await storage.permissions.count({ group: "Reportes" })).toBe(1);
    await expect(storage.permissions.unregister("appointments.read")).rejects.toMatchObject({ code: "permission_has_dependents" });
    await storage.permissions.unregister("appointments.admin");
    await storage.permissions.unregister("appointments.write");
    await storage.permissions.unregister("appointments.read");
    expect(await storage.permissions.findByKey("appointments.read")).toBeNull();
  });
});
