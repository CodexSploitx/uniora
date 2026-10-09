import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAccessAdminService, createGuardedStorage, createInvitationService, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import { accessCommand } from "./access.js";

const owner = { provider: "p", subject: "owner" };
const mgr = { provider: "p", subject: "mgr" };
const ana = { provider: "p", subject: "ana" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve() {
  const raw = createMemoryStorage();
  for (const key of ["reports.read", "billing.manage", "members.roles.manage", "members.invite"]) await raw.permissions.register({ key });
  await createOrganizationWithOwner(raw, { organizationId: "org", organizationName: "Acme", ownerRoleId: "owner", membershipId: "m-owner", ownerIdentity: owner });
  await raw.roles.create({ id: "viewer", organizationId: "org", name: "Viewer", permissionKeys: ["reports.read"] });
  await raw.roles.create({ id: "billing", organizationId: "org", name: "Billing", permissionKeys: ["billing.manage"] });
  await raw.roles.create({ id: "manager", organizationId: "org", name: "Manager", permissionKeys: ["members.roles.manage", "members.invite", "reports.read"] });
  await raw.memberships.create({ id: "m-mgr", organizationId: "org", identity: mgr, roleIds: ["manager"] });
  await raw.memberships.create({ id: "m-ana", organizationId: "org", identity: ana });
  const storage = createGuardedStorage(raw);
  const services = {
    access: createAccessAdminService({ storage }),
    invitations: createInvitationService({ storage, acceptUrl: (token) => `https://app.test/invite/${token}` }),
  };
  const resolve = (req: { header(name: string): string | undefined }) => {
    const who = req.header("x-test-user");
    return who === "mgr" ? { actor: mgr, organizationId: "org" } : who === "ana" ? { actor: ana, organizationId: "org" } : null;
  };
  const app = express();
  app.use(express.json());
  app.put("/members/:membershipId/roles/:roleId", accessCommand(services, { command: "assignRole", resolve }));
  app.post("/invitations", accessCommand(services, { command: "inviteMember", resolve }));
  const server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const send = (method: string, url: string, user: string | null, body: unknown = {}) =>
  fetch(url, { method, headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: JSON.stringify(body) });

describe("accessCommand", () => {
  it("answers 401 without a caller", async () => {
    const { base } = await serve();
    expect((await send("PUT", `${base}/members/m-ana/roles/viewer`, null)).status).toBe(401);
  });

  it("gives a role (the path wins over the body) and hides the invitation link", async () => {
    const { base } = await serve();
    const given = await send("PUT", `${base}/members/m-ana/roles/viewer`, "mgr", { roleId: "billing" });
    expect(given.status).toBe(200);
    expect(await given.json()).toMatchObject({ id: "m-ana", roleIds: ["viewer"] });
    const invited = await send("POST", `${base}/invitations`, "mgr", { email: "new@example.com", roleIds: ["viewer"] });
    expect(invited.status).toBe(200);
    const body = (await invited.json()) as Record<string, unknown>;
    expect(body.acceptUrl).toBeUndefined();
    expect(body.invitation).toMatchObject({ email: "new@example.com" });
  });

  it("answers 403, with the reason once the caller passed the gate, and 400 for fields the client must not set", async () => {
    const { base } = await serve();
    const plain = await send("PUT", `${base}/members/m-ana/roles/viewer`, "ana");
    expect(plain.status).toBe(403);
    expect(await plain.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
    const escalation = await send("PUT", `${base}/members/m-ana/roles/billing`, "mgr");
    expect(escalation.status).toBe(403);
    expect(await escalation.json()).toMatchObject({ error: "forbidden", reason: "access_escalation" });
    const money = await send("POST", `${base}/invitations`, "mgr", { email: "x@example.com", roleIds: ["billing"] });
    expect(money.status).toBe(403);
    expect(await money.json()).toMatchObject({ error: "forbidden" });
    expect((await send("PUT", `${base}/members/m-ana/roles/viewer`, "mgr", { actor: owner })).status).toBe(400);
  });
});
