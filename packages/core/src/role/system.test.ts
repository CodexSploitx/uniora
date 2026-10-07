import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { applyRoleTemplates } from "./templates.js";

async function seed() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org-1", name: "Acme" });
  await storage.organizations.create({ id: "org-2", name: "Otra" });
  for (const key of ["a.read", "a.write", "b.read"]) await storage.permissions.register({ key });
  return storage;
}

describe("system roles, setPermissions, clone and delete policy (memory)", () => {
  it("a system role cannot be renamed or deleted, but its description and permissions can change", async () => {
    const storage = await seed();
    await storage.roles.create({ id: "sys", organizationId: "org-1", name: "Front desk", isSystem: true, description: " Door " });
    expect((await storage.roles.findByIds(["sys"]))[0]).toMatchObject({ isSystem: true, description: "Door" });
    await expect(storage.roles.rename("sys", "X")).rejects.toMatchObject({ code: "role_system_protected" });
    await expect(storage.roles.update("sys", { name: "X" })).rejects.toMatchObject({ code: "role_system_protected" });
    await expect(storage.roles.delete("sys")).rejects.toMatchObject({ code: "role_system_protected" });
    expect(await storage.roles.update("sys", { description: null })).not.toHaveProperty("description");
    await storage.roles.grantPermission("sys", "a.read");
    expect(await storage.roles.count({ isSystem: true })).toBe(1);
  });

  it("setPermissions replaces the list, reports the diff and rejects unknown keys without changing anything", async () => {
    const storage = await seed();
    await storage.roles.create({ id: "r", organizationId: "org-1", name: "R", permissionKeys: ["a.read", "b.read"] });
    expect(await storage.roles.setPermissions("r", ["a.read", "a.write"])).toEqual({ granted: ["a.write"], revoked: ["b.read"] });
    await expect(storage.roles.setPermissions("r", ["a.read", "ghost.key"])).rejects.toMatchObject({ code: "role_permission_invalid" });
    expect((await storage.roles.findByIds(["r"]))[0]?.permissionKeys.sort()).toEqual(["a.read", "a.write"]);
  });

  it("clone copies permissions, never the system flag, and refuses the Owner role", async () => {
    const storage = await seed();
    await storage.roles.createOwnerRole({ id: "owner", organizationId: "org-1" });
    await storage.roles.create({ id: "sys", organizationId: "org-1", name: "Front desk", isSystem: true, permissionKeys: ["a.read"] });
    const copy = await storage.roles.clone("sys", { id: "copy", name: "Front desk 2", organizationId: "org-2" });
    expect(copy).toMatchObject({ organizationId: "org-2", isSystem: false, permissionKeys: ["a.read"] });
    await storage.roles.revokePermission("copy", "a.read");
    expect((await storage.roles.findByIds(["sys"]))[0]?.permissionKeys).toEqual(["a.read"]);
    await expect(storage.roles.clone("owner", { id: "x", name: "X" })).rejects.toMatchObject({ code: "owner_role_protected" });
  });

  it("delete: detach by default, reject while held, reassign to another role of the same organization", async () => {
    const storage = await seed();
    await storage.roles.create({ id: "old", organizationId: "org-1", name: "Old" });
    await storage.roles.create({ id: "new", organizationId: "org-1", name: "New" });
    await storage.roles.create({ id: "foreign", organizationId: "org-2", name: "Foreign" });
    await storage.memberships.create({ id: "m", organizationId: "org-1", identity: { provider: "p", subject: "m" }, roleIds: ["old"] });
    await expect(storage.roles.delete("old", { members: "reject" })).rejects.toMatchObject({ code: "role_in_use" });
    await expect(storage.roles.delete("old", { members: { reassignTo: "foreign" } })).rejects.toMatchObject({ code: "role_reassign_invalid" });
    await storage.roles.delete("old", { members: { reassignTo: "new" } });
    expect((await storage.memberships.findById("m"))?.roleIds).toEqual(["new"]);
    await storage.roles.delete("new");
    expect((await storage.memberships.findById("m"))?.roleIds).toEqual([]);
  });

  it("applyRoleTemplates is idempotent, syncs system roles and leaves a tenant's own role alone", async () => {
    const storage = await seed();
    const template = { key: "desk", name: "Front desk", description: "Door", permissionKeys: ["a.read", "a.write"] };
    expect((await applyRoleTemplates(storage.roles, "org-1", [template])).created).toHaveLength(1);
    const synced = await applyRoleTemplates(storage.roles, "org-1", [{ ...template, permissionKeys: ["a.read"], description: "New" }]);
    expect(synced.created).toEqual([]);
    expect((await storage.roles.listByOrganization("org-1"))[0]).toMatchObject({ permissionKeys: ["a.read"], description: "New", isSystem: true });
    await storage.roles.create({ id: "mine", organizationId: "org-2", name: "Mine", key: "desk" });
    expect((await applyRoleTemplates(storage.roles, "org-2", [template])).skipped).toEqual(["desk"]);
  });

  it("applyRoleTemplates: a name taken by a tenant's role is a conflict and the next templates are still created", async () => {
    const storage = await seed();
    await storage.roles.create({ id: "mine", organizationId: "org-1", name: "Front desk", key: "mine" });
    const result = await applyRoleTemplates(storage.roles, "org-1", [
      { key: "desk", name: "Front desk", permissionKeys: ["a.read"] },
      { key: "ops", name: "Operations", permissionKeys: ["a.write"] },
    ]);
    expect(result.conflicts).toEqual([{ key: "desk", reason: "name_taken" }]);
    expect(result.created.map((role) => role.key)).toEqual(["ops"]);
    expect((await storage.roles.listByOrganization("org-1")).map((role) => role.key).sort()).toEqual(["mine", "ops"]);
  });

  it("applyRoleTemplates: create-missing never changes an existing role, even one the Owner edited", async () => {
    const storage = await seed();
    const desk = { key: "desk", name: "Front desk", description: "Door", permissionKeys: ["a.read", "a.write"] };
    await applyRoleTemplates(storage.roles, "org-1", [desk]);
    const role = (await storage.roles.listByOrganization("org-1"))[0]!;
    await storage.roles.setPermissions(role.id, ["b.read"]);
    await storage.roles.update(role.id, { description: "Edited by the Owner" });

    const result = await applyRoleTemplates(
      storage.roles,
      "org-1",
      [desk, { key: "ops", name: "Operations", permissionKeys: ["a.read"] }],
      { mode: "create-missing" },
    );
    expect(result.unchanged).toEqual(["desk"]);
    expect(result.synced).toEqual([]);
    expect(result.created.map((created) => created.key)).toEqual(["ops"]);
    expect((await storage.roles.findByIds([role.id]))[0]).toMatchObject({ permissionKeys: ["b.read"], description: "Edited by the Owner" });
    // The default mode still syncs, as before.
    expect((await applyRoleTemplates(storage.roles, "org-1", [desk])).synced).toHaveLength(1);
  });

  it("applyRoleTemplates: continueOnError records a failing template and applies the rest; without it the error is thrown", async () => {
    const storage = await seed();
    // The SQL backends reject an unregistered permission key; stand in for that here.
    const roles = {
      ...storage.roles,
      create: async (input: Parameters<typeof storage.roles.create>[0]) => {
        if (input.key === "bad") throw new Error("permission not registered");
        return storage.roles.create(input);
      },
    };
    const templates = [
      { key: "bad", name: "Bad", permissionKeys: ["ghost.key"] },
      { key: "ops", name: "Operations", permissionKeys: ["a.read"] },
    ];
    await expect(applyRoleTemplates(roles, "org-1", templates)).rejects.toThrow("permission not registered");
    expect(await storage.roles.listByOrganization("org-1")).toEqual([]);

    const result = await applyRoleTemplates(roles, "org-2", templates, { continueOnError: true });
    expect(result.failed.map((failure) => failure.key)).toEqual(["bad"]);
    expect(result.created.map((created) => created.key)).toEqual(["ops"]);
  });
});
