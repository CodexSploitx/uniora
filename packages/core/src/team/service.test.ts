import { describe, expect, it } from "vitest";
import { TEAM_PERMISSIONS, TeamError, createAuthorizationEngine, createMemoryStorage, createTeamService, createTrustedTeamStorage } from "../index.js";

const boss = { provider: "p", subject: "boss" }; // organization Owner
const hr = { provider: "p", subject: "hr" }; // organization-wide team administrator
const lead = { provider: "p", subject: "lead" }; // manager of Barcelona only
const juan = { provider: "p", subject: "juan" }; // plain member of Barcelona
const luis = { provider: "p", subject: "luis" }; // plain member of Madrid
const stranger = { provider: "p", subject: "stranger" }; // member of another organization

const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof TeamError ? error.code : String(error)));

async function seed() {
  const raw = createMemoryStorage();
  const storage = createTrustedTeamStorage(raw, { actor: boss, reason: "unit test fixtures" });
  await storage.organizations.create({ id: "org", name: "Acme" });
  await storage.organizations.create({ id: "other", name: "Other" });
  const owner = await storage.roles.createOwnerRole({ id: "owner", organizationId: "org" });
  await storage.roles.create({ id: "hr", organizationId: "org", name: "HR", permissionKeys: Object.values(TEAM_PERMISSIONS) });
  await storage.roles.create({ id: "lead", organizationId: "org", name: "Team lead", permissionKeys: [TEAM_PERMISSIONS.membersAdd, TEAM_PERMISSIONS.membersManage, "vehicles.read"] });
  await storage.roles.create({ id: "reader", organizationId: "org", name: "Reader", permissionKeys: ["vehicles.read"] });
  await storage.roles.create({ id: "super", organizationId: "org", name: "Super", permissionKeys: ["vehicles.read", "billing.write"] });
  const member = (id: string, identity: typeof boss, roleIds: string[] = []) => storage.memberships.create({ id, organizationId: "org", identity, roleIds });
  const mBoss = await member("m-boss", boss);
  await storage.memberships.assignOwnerRole(mBoss.id, owner.id);
  await member("m-hr", hr, ["hr"]);
  await member("m-lead", lead);
  await member("m-juan", juan);
  await member("m-luis", luis);
  await storage.organizations.create({ id: "other-2", name: "Third" });
  await storage.memberships.create({ id: "m-stranger", organizationId: "other", identity: stranger });
  const bcn = await storage.teams.create({ id: "bcn", organizationId: "org", name: "Barcelona" });
  const mad = await storage.teams.create({ id: "mad", organizationId: "org", name: "Madrid" });
  await storage.teamMemberships.add({ id: "tm-lead", organizationId: "org", teamId: bcn.id, membershipId: "m-lead", responsibility: "manager", roleIds: ["lead"] });
  await storage.teamMemberships.add({ id: "tm-juan", organizationId: "org", teamId: bcn.id, membershipId: "m-juan", roleIds: ["reader"] });
  await storage.teamMemberships.add({ id: "tm-luis", organizationId: "org", teamId: mad.id, membershipId: "m-luis", roleIds: ["reader"] });
  return { storage, service: createTeamService({ storage: raw }), engine: createAuthorizationEngine(raw), raw };
}

describe("engine: team context only narrows, never grants", () => {
  it("answers the vehicles example: allowed in your team, denied in another", async () => {
    const { engine } = await seed();
    expect(await engine.can({ identity: juan, organizationId: "org", permission: "vehicles.read", teamId: "bcn" })).toBe(true);
    expect(await engine.can({ identity: juan, organizationId: "org", permission: "vehicles.read", teamId: "mad" })).toBe(false);
    expect(await engine.can({ identity: luis, organizationId: "org", permission: "vehicles.read", teamId: "mad" })).toBe(true);
  });

  it("a team role holds its permission only inside that team", async () => {
    const { engine } = await seed();
    const ask = (identity: typeof lead, teamId?: string) => engine.can({ identity, organizationId: "org", permission: TEAM_PERMISSIONS.membersAdd, ...(teamId ? { teamId } : {}) });
    expect(await ask(lead, "bcn")).toBe(true);
    expect(await ask(lead, "mad")).toBe(false);
    expect(await ask(lead)).toBe(false);
  });

  it("owning or managing a team opens nothing by itself, and the organization Owner still needs membership in team context", async () => {
    const { storage, engine } = await seed();
    await storage.teamMemberships.setResponsibility("org", "tm-juan", "owner");
    expect(await engine.can({ identity: juan, organizationId: "org", permission: "billing.write", teamId: "bcn" })).toBe(false);
    expect(await engine.can({ identity: boss, organizationId: "org", permission: "vehicles.read" })).toBe(true);
    expect(await engine.can({ identity: boss, organizationId: "org", permission: "vehicles.read", teamId: "bcn" })).toBe(false);
  });

  it("is denied for unknown, foreign, archived teams and for pending, suspended or removed members", async () => {
    const { storage, engine } = await seed();
    const ask = (teamId: unknown) => engine.can({ identity: juan, organizationId: "org", permission: "vehicles.read", teamId: teamId as string });
    expect(await ask("nope")).toBe(false);
    expect(await ask(42)).toBe(false);
    expect(await ask(undefined)).toBe(false); // no team context: only organization roles count, a team role never leaks out of its team
    await storage.teams.create({ id: "foreign", organizationId: "other", name: "Foreign" });
    expect(await ask("foreign")).toBe(false);
    const actor = boss;
    await storage.teamMemberships.setStatus("org", "tm-juan", "suspended", { actor });
    expect(await ask("bcn")).toBe(false);
    await storage.teamMemberships.setStatus("org", "tm-juan", "active", { actor });
    expect(await ask("bcn")).toBe(true);
    await storage.teams.archive("org", "bcn", { actor });
    expect(await ask("bcn")).toBe(false);
    await storage.teams.restore("org", "bcn", { actor });
    await storage.teamMemberships.setStatus("org", "tm-juan", "removed", { actor });
    expect(await ask("bcn")).toBe(false);
    await storage.memberships.block("m-luis", { actor });
    expect(await engine.can({ identity: luis, organizationId: "org", permission: "vehicles.read", teamId: "mad" })).toBe(false);
  });

  it("access.check with a team requires active membership of that team", async () => {
    const { engine } = await seed();
    expect(await engine.access.check({ identity: juan, organizationId: "org", teamId: "bcn" })).toBe(true);
    expect(await engine.access.check({ identity: juan, organizationId: "org", teamId: "mad" })).toBe(false);
    expect(await engine.access.check({ identity: stranger, organizationId: "org", teamId: "bcn" })).toBe(false);
  });
});

describe("team service: nobody changes team without permission", () => {
  it("a plain member cannot add themselves to another team, nor anyone else", async () => {
    const { service } = await seed();
    const attempt = (actor: typeof juan, membershipId: string, teamId: string) =>
      code(service.addMember({ actor, id: `x-${membershipId}-${teamId}`, organizationId: "org", teamId, membershipId }));
    expect(await attempt(juan, "m-juan", "mad")).toBe("team_forbidden");
    expect(await attempt(juan, "m-luis", "bcn")).toBe("team_forbidden");
    expect(await attempt(stranger, "m-juan", "mad")).toBe("team_forbidden");
  });

  it("a team lead can add people to their own team only, and only with roles they hold themselves", async () => {
    const { service, storage } = await seed();
    await storage.memberships.create({ id: "m-new", organizationId: "org", identity: { provider: "p", subject: "new" } });
    expect(await code(service.addMember({ actor: lead, id: "a1", organizationId: "org", teamId: "bcn", membershipId: "m-new", roleIds: ["reader"] }))).toBe("ok");
    expect(await code(service.addMember({ actor: lead, id: "a2", organizationId: "org", teamId: "mad", membershipId: "m-juan" }))).toBe("team_forbidden");
    expect(await code(service.assignRole({ actor: lead, organizationId: "org", teamMembershipId: "a1", roleId: "super" }))).toBe("team_forbidden");
    expect(await code(service.assignRole({ actor: lead, organizationId: "org", teamMembershipId: "a1", roleId: "lead" }))).toBe("ok");
    expect(await code(service.setResponsibility({ actor: lead, organizationId: "org", teamMembershipId: "a1", responsibility: "owner" }))).toBe("team_forbidden");
  });

  it("nobody promotes themselves, gives themselves roles or lifts their own suspension", async () => {
    const { service, storage } = await seed();
    expect(await code(service.setResponsibility({ actor: lead, organizationId: "org", teamMembershipId: "tm-lead", responsibility: "owner" }))).toBe("team_forbidden");
    expect(await code(service.assignRole({ actor: lead, organizationId: "org", teamMembershipId: "tm-lead", roleId: "reader" }))).toBe("team_forbidden");
    await storage.teamMemberships.setStatus("org", "tm-lead", "suspended", { actor: boss });
    expect(await code(service.reactivateMember({ actor: lead, organizationId: "org", teamMembershipId: "tm-lead" }))).toBe("team_forbidden");
  });

  it("moving between teams needs the right in both, and a lead of one team cannot do it", async () => {
    const { service, storage } = await seed();
    const move = (actor: typeof lead) => service.moveMember({ actor, organizationId: "org", membershipId: "m-juan", fromTeamId: "bcn", toTeamId: "mad", id: "moved" });
    expect(await code(move(juan))).toBe("team_forbidden");
    expect(await code(move(lead))).toBe("team_forbidden");
    expect((await storage.teamMemberships.find("org", "bcn", "m-juan"))?.status).toBe("active");
    expect(await storage.teamMemberships.find("org", "mad", "m-juan")).toBeNull();
    const moved = await service.moveMember({ actor: hr, organizationId: "org", membershipId: "m-juan", fromTeamId: "bcn", toTeamId: "mad", id: "moved" });
    expect(moved).toMatchObject({ teamId: "mad", status: "active", invitedBy: hr });
    expect((await storage.teamMemberships.find("org", "bcn", "m-juan"))?.status).toBe("removed");
  });

  it("a failed move changes nothing (destination archived)", async () => {
    const { service, storage } = await seed();
    await storage.teams.archive("org", "mad", { actor: boss });
    expect(await code(service.moveMember({ actor: hr, organizationId: "org", membershipId: "m-juan", fromTeamId: "bcn", toTeamId: "mad", id: "m1" }))).toBe("team_archived");
    expect((await storage.teamMemberships.find("org", "bcn", "m-juan"))?.status).toBe("active");
  });

  it("only the invited person accepts; anyone can leave only for themselves", async () => {
    const { service, storage } = await seed();
    await service.addMember({ actor: hr, id: "inv", organizationId: "org", teamId: "mad", membershipId: "m-juan", status: "pending" });
    expect(await code(service.acceptInvitation({ actor: luis, organizationId: "org", teamMembershipId: "inv" }))).toBe("team_accept_forbidden");
    expect(await code(service.acceptInvitation({ actor: hr, organizationId: "org", teamMembershipId: "inv" }))).toBe("team_accept_forbidden");
    expect(await code(service.acceptInvitation({ actor: juan, organizationId: "org", teamMembershipId: "inv" }))).toBe("ok");
    expect(await code(service.removeMember({ actor: luis, organizationId: "org", teamMembershipId: "inv" }))).toBe("team_forbidden");
    expect(await code(service.leaveTeam({ actor: juan, organizationId: "org", teamId: "mad" }))).toBe("ok");
    expect((await storage.teamMemberships.find("org", "mad", "m-juan"))?.status).toBe("removed");
  });

  it("an administrator of one organization cannot touch another organization's teams or members", async () => {
    const { service, storage } = await seed();
    await storage.roles.createOwnerRole({ id: "owner-other", organizationId: "other" });
    await storage.memberships.assignOwnerRole("m-stranger", "owner-other");
    await storage.teams.create({ id: "t-other", organizationId: "other", name: "Foreign" });
    // The Owner of "other" aims at org's team and members, with and without the right organization id.
    expect(await code(service.archiveTeam({ actor: stranger, organizationId: "org", teamId: "bcn" }))).toBe("team_forbidden");
    expect(await code(service.addMember({ actor: stranger, id: "z", organizationId: "org", teamId: "bcn", membershipId: "m-juan" }))).toBe("team_forbidden");
    expect(await code(service.addMember({ actor: stranger, id: "z", organizationId: "other", teamId: "bcn", membershipId: "m-juan" }))).toBe("team_not_found");
    expect(await code(service.addMember({ actor: stranger, id: "z", organizationId: "other", teamId: "t-other", membershipId: "m-juan" }))).toBe("team_member_unknown");
    expect(await code(service.removeMember({ actor: stranger, organizationId: "other", teamMembershipId: "tm-juan" }))).toBe("team_membership_not_found");
  });

  it("team administration needs teams.manage, organization-wide or inside the team; deleting needs it organization-wide", async () => {
    const { service } = await seed();
    expect(await code(service.updateTeam({ actor: juan, organizationId: "org", teamId: "bcn", name: "Hack" }))).toBe("team_forbidden");
    expect(await code(service.createTeam({ actor: lead, id: "t3", organizationId: "org", name: "Three" }))).toBe("team_forbidden");
    expect(await code(service.createTeam({ actor: hr, id: "t3", organizationId: "org", name: "Three" }))).toBe("ok");
    expect(await code(service.archiveTeam({ actor: hr, organizationId: "org", teamId: "t3" }))).toBe("ok");
    expect(await code(service.deleteTeam({ actor: lead, organizationId: "org", teamId: "t3" }))).toBe("team_forbidden");
    expect(await code(service.deleteTeam({ actor: hr, organizationId: "org", teamId: "t3" }))).toBe("ok");
  });

  it("records who did each change in the audit log", async () => {
    const { service, raw: storage } = await seed();
    await service.addMember({ actor: hr, id: "aud", organizationId: "org", teamId: "mad", membershipId: "m-juan" });
    const entries = await storage.auditLogs.search({ actionPrefix: "team_member." });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "team_member.added", actor: hr });
  });
});
