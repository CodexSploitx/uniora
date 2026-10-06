import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createInvitationService, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import { acceptInvitation, invitationPreview } from "./invitations.js";

const owner = { provider: "supabase", subject: "owner-1" };
const invitee = { provider: "supabase", subject: "invitee-1" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve() {
  const storage = createMemoryStorage();
  await createOrganizationWithOwner(storage, {
    organizationId: "org-1",
    organizationName: "Acme Motors",
    ownerRoleId: "role-owner",
    membershipId: "m-owner",
    ownerIdentity: owner,
  });
  await storage.roles.create({ id: "role-viewer", organizationId: "org-1", name: "Viewer", permissionKeys: [] });
  const service = createInvitationService({ storage, acceptUrl: (token) => `https://app.test/invite/${token}`, sleep: async () => {} });
  const { acceptUrl } = await service.invite({ organizationId: "org-1", email: "ana@example.com", roleIds: ["role-viewer"], invitedBy: owner });
  const token = acceptUrl.split("/invite/")[1]!;

  const app = express();
  app.get("/invite/:token", invitationPreview(service, { token: (req) => req.params.token }));
  app.post(
    "/invite/:token/accept",
    acceptInvitation(service, {
      token: (req) => req.params.token,
      resolve: (req) => {
        const email = req.header("x-test-email");
        return email ? { identity: invitee, verifiedEmail: email } : null;
      },
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return { token, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("invitationPreview", () => {
  it("shows the invitation and answers 404 for an unknown token", async () => {
    const { base, token } = await serve();
    const ok = await fetch(`${base}/invite/${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ organizationName: "Acme Motors", email: "ana@example.com" });
    const missing = await fetch(`${base}/invite/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "invalid_invitation" });
  });
});

describe("acceptInvitation", () => {
  it("answers 401 without a caller", async () => {
    const { base, token } = await serve();
    expect((await fetch(`${base}/invite/${token}/accept`, { method: "POST" })).status).toBe(401);
  });

  it("joins with a matching verified e-mail, then refuses the used link with a generic 400", async () => {
    const { base, token } = await serve();
    const headers = { "x-test-email": "ana@example.com" };
    const joined = await fetch(`${base}/invite/${token}/accept`, { method: "POST", headers });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ organizationId: "org-1", alreadyMember: false });
    const again = await fetch(`${base}/invite/${token}/accept`, { method: "POST", headers });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_invitation" });
  });

  it("refuses a different verified e-mail with the same generic 400", async () => {
    const { base, token } = await serve();
    const response = await fetch(`${base}/invite/${token}/accept`, { method: "POST", headers: { "x-test-email": "eve@example.com" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_invitation" });
  });
});
