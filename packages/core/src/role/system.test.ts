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
});
