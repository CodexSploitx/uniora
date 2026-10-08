import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createTrustedTeamStorage } from "../team/trusted.js";
import { createOrganizationWithOwner } from "../organization/create-with-owner.js";
import { InvitationError } from "./repository.js";
import { createInvitationService } from "./service.js";

const owner = { provider: "p", subject: "owner" };
const lead = { provider: "p", subject: "lead" };
const invitee = { provider: "p", subject: "invitee" };

async function setup() {
  const raw = createMemoryStorage();
  const storage = createTrustedTeamStorage(raw, { actor: owner, reason: "unit test fixtures" });
  await createOrganizationWithOwner(raw, { organizationId: "org", organizationName: "Acme", ownerRoleId: "owner-role", membershipId: "m-owner", ownerIdentity: owner });
  await raw.organizations.create({ id: "other", name: "Other" });
  await raw.roles.create({ id: "reader", organizationId: "org", name: "Reader", permissionKeys: ["x.read"] });
  await raw.roles.create({ id: "recruiter", organizationId: "org", name: "Recruiter", permissionKeys: ["teams.members.add"] });
  await raw.memberships.create({ id: "m-lead", organizationId: "org", identity: lead, roleIds: ["recruiter"] });
  await storage.teams.create({ id: "bcn", organizationId: "org", name: "Barcelona" });
  await storage.teams.create({ id: "mad", organizationId: "org", name: "Madrid" });
  await storage.teams.create({ id: "foreign", organizationId: "other", name: "Foreign" });
  let n = 0;
  const service = createInvitationService({ storage: raw, acceptUrl: (t) => `https://app.test/invite/${t}`, generateId: () => `id-${++n}` });
  const token = (url: string) => url.split("/invite/")[1]!;
  const accept = (url: string, email = "ana@example.com") => service.accept({ token: token(url), identity: invitee, verifiedEmail: email });
  const invite = (extra: Record<string, unknown> = {}, by = owner) =>
    service.invite({ organizationId: "org", email: "ana@example.com", roleIds: ["reader"], invitedBy: by, ...extra });
  return { raw, storage, service, accept, invite };
}

describe("invitations that offer teams", () => {
  it("joins the offered teams as plain members when the invitation is accepted, and previews their names", async () => {
    const { invite, accept, service, raw } = await setup();
    const { acceptUrl, invitation } = await invite({ teamIds: ["mad", "bcn"] });
    expect(invitation.teamIds).toEqual(["bcn", "mad"]);
    expect((await service.preview(acceptUrl.split("/invite/")[1]!))?.teamNames.sort()).toEqual(["Barcelona", "Madrid"]);
    expect(await raw.teamMemberships.search({ organizationId: "org", teamId: "bcn" })).toHaveLength(0); // an offer grants nothing yet

    const result = await accept(acceptUrl);
    expect(result.teamsSkipped).toEqual([]);
    expect(result.teams.map((row) => [row.teamId, row.status, row.responsibility, row.roleIds]).sort()).toEqual([
      ["bcn", "active", "member", []],
      ["mad", "active", "member", []],
    ]);
    const log = await raw.auditLogs.listByOrganization("org");
    expect(log.filter((e) => e.action === "team_member.added")).toHaveLength(2);
  });

  it("refuses to offer a team the inviter may not add people to, or one of another organization", async () => {
    const { invite, raw } = await setup();
    await raw.roles.create({ id: "nobody", organizationId: "org", name: "Nobody", permissionKeys: [] });
    await raw.memberships.create({ id: "m-plain", organizationId: "org", identity: { provider: "p", subject: "plain" }, roleIds: ["nobody"] });
    await expect(invite({ teamIds: ["bcn"] }, { provider: "p", subject: "plain" })).rejects.toMatchObject({ reason: "teams_forbidden" });
    await expect(invite({ teamIds: ["foreign"] })).rejects.toMatchObject({ reason: "bad_request" });
    await expect(invite({ teamIds: ["nope"] })).rejects.toBeInstanceOf(InvitationError);
    await expect(invite({ teamIds: ["bcn"] }, lead)).resolves.toBeTruthy(); // organization-wide right
  });

  it("re-checks the inviter at accept time: a lost right means the person joins the organization but not the team", async () => {
    const { invite, accept, raw } = await setup();
    const { acceptUrl } = await invite({ teamIds: ["bcn"] }, lead);
    await raw.memberships.unassignRole("m-lead", "recruiter");
    const result = await accept(acceptUrl);
    expect(result.membership.roleIds).toEqual(["reader"]);
    expect(result.teams).toEqual([]);
    expect(result.teamsSkipped).toEqual(["bcn"]);
    expect(await raw.teamMemberships.search({ organizationId: "org", teamId: "bcn" })).toHaveLength(0);
  });

  it("skips archived teams and never lifts a suspension or a membership the person already has", async () => {
    const { invite, accept, storage, raw } = await setup();
    const { acceptUrl } = await invite({ teamIds: ["bcn", "mad"] });
    const member = await raw.memberships.create({ id: "m-invitee", organizationId: "org", identity: invitee, roleIds: [] });
    await storage.teamMemberships.add({ id: "tm-1", organizationId: "org", teamId: "mad", membershipId: member.id });
    await storage.teamMemberships.setStatus("org", "tm-1", "suspended", { actor: owner });
    await storage.teams.archive("org", "bcn", { actor: owner });

    const result = await accept(acceptUrl);
    expect(result.teams).toEqual([]);
    expect(result.teamsSkipped.sort()).toEqual(["bcn", "mad"]);
    expect((await raw.teamMemberships.findById("org", "tm-1"))?.status).toBe("suspended");
  });

  it("an offer disappears with its team, and a replay with different teams is an idempotency conflict", async () => {
    const { invite, accept, storage } = await setup();
    const { acceptUrl } = await invite({ teamIds: ["bcn"], idempotencyKey: "k1" });
    await expect(invite({ teamIds: ["mad"], idempotencyKey: "k1" })).rejects.toMatchObject({ reason: "idempotency_conflict" });
    await storage.teams.archive("org", "bcn", { actor: owner });
    await storage.teams.delete("org", "bcn", { actor: owner });
    const result = await accept(acceptUrl);
    expect(result.teams).toEqual([]);
    expect(result.teamsSkipped).toEqual([]);
  });
});
