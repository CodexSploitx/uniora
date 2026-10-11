import { describe, expect, it } from "vitest";
import { createAccessAdminService, createGuardedStorage, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import { accessCommandRoute } from "./access.js";

const owner = { provider: "p", subject: "owner" };
const mgr = { provider: "p", subject: "mgr" };
const ana = { provider: "p", subject: "ana" };

async function setup() {
  const raw = createMemoryStorage();
  for (const key of ["reports.read", "billing.manage", "members.roles.manage"]) await raw.permissions.register({ key });
  await createOrganizationWithOwner(raw, { organizationId: "org", organizationName: "Acme", ownerRoleId: "owner", membershipId: "m-owner", ownerIdentity: owner });
  await raw.roles.create({ id: "viewer", organizationId: "org", name: "Viewer", permissionKeys: ["reports.read"] });
  await raw.roles.create({ id: "billing", organizationId: "org", name: "Billing", permissionKeys: ["billing.manage"] });
  await raw.roles.create({ id: "manager", organizationId: "org", name: "Manager", permissionKeys: ["members.roles.manage", "reports.read"] });
  await raw.memberships.create({ id: "m-mgr", organizationId: "org", identity: mgr, roleIds: ["manager"] });
  await raw.memberships.create({ id: "m-ana", organizationId: "org", identity: ana });
  return { access: createAccessAdminService({ storage: createGuardedStorage(raw) }) };
}

describe("accessCommandRoute", () => {
  it("answers 401 without a caller", async () => {
    const services = await setup();
    expect((await accessCommandRoute(services, { command: "assignRole", caller: null, params: {} })).status).toBe(401);
  });

  it("runs the command as the caller and maps refusals", async () => {
    const services = await setup();
    const ok = await accessCommandRoute(services, { command: "assignRole", caller: { actor: mgr, organizationId: "org" }, params: { membershipId: "m-ana", roleId: "viewer" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ roleIds: ["viewer"] });
    const plain = await accessCommandRoute(services, { command: "assignRole", caller: { actor: ana, organizationId: "org" }, params: { membershipId: "m-ana", roleId: "viewer" } });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
    const escalation = await accessCommandRoute(services, { command: "assignRole", caller: { actor: mgr, organizationId: "org" }, params: { membershipId: "m-ana", roleId: "billing" } });
    expect(await escalation.json()).toMatchObject({ error: "forbidden", reason: "access_escalation" });
  });

  it("rejects fields the client must not set and rethrows what is not an access error", async () => {
    const services = await setup();
    const bad = await accessCommandRoute(services, { command: "assignRole", caller: { actor: mgr, organizationId: "org" }, params: { membershipId: "m-ana", roleId: "viewer", authorization: {} } });
    expect(bad.status).toBe(400);
    await expect(
      accessCommandRoute({ access: { ...services.access, assignRole: async () => { throw new Error("db down"); } } }, { command: "assignRole", caller: { actor: mgr, organizationId: "org" }, params: { membershipId: "m-ana", roleId: "viewer" } }),
    ).rejects.toThrow("db down");
  });
});
