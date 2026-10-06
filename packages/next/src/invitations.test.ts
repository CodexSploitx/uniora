import { describe, expect, it } from "vitest";
import { createInvitationService, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import { acceptInvitationRoute, previewInvitationRoute } from "./invitations.js";

const owner = { provider: "supabase", subject: "owner-1" };
const invitee = { provider: "supabase", subject: "invitee-1" };

async function setup() {
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
  return { service, token: acceptUrl.split("/invite/")[1]! };
}

describe("previewInvitationRoute", () => {
  it("shows what the accept page needs", async () => {
    const { service, token } = await setup();
    const response = await previewInvitationRoute(service, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationName: "Acme Motors", email: "ana@example.com", roleNames: ["Viewer"] });
  });

  it("answers the same 404 for an unknown or missing token", async () => {
    const { service } = await setup();
    for (const token of ["nope", "", undefined]) {
      const response = await previewInvitationRoute(service, token);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "invalid_invitation" });
    }
  });
});

describe("acceptInvitationRoute", () => {
  it("answers 401 for an unauthenticated caller and leaves the invitation usable", async () => {
    const { service, token } = await setup();
    expect((await acceptInvitationRoute(service, { token, caller: null })).status).toBe(401);
    expect((await previewInvitationRoute(service, token)).status).toBe(200);
  });

  it("joins the organization when the verified e-mail matches", async () => {
    const { service, token } = await setup();
    const response = await acceptInvitationRoute(service, { token, caller: { identity: invitee, verifiedEmail: "Ana@Example.com" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationId: "org-1", alreadyMember: false });
  });

  it("answers one generic 400 for a wrong e-mail and for a reused link", async () => {
    const { service, token } = await setup();
    const wrong = await acceptInvitationRoute(service, { token, caller: { identity: invitee, verifiedEmail: "eve@example.com" } });
    expect(wrong.status).toBe(400);
    const wrongBody = await wrong.json();
    expect(wrongBody.error).toBe("invalid_invitation");

    await acceptInvitationRoute(service, { token, caller: { identity: invitee, verifiedEmail: "ana@example.com" } });
    const reused = await acceptInvitationRoute(service, { token, caller: { identity: invitee, verifiedEmail: "ana@example.com" } });
    expect(await reused.json()).toEqual(wrongBody);
  });
});
