import { describe, expect, it } from "vitest";
import { TEAM_PERMISSIONS, createMemoryStorage, createTeamService } from "@uniora/core";
import { teamCommandRoute } from "./teams.js";

const hr = { provider: "p", subject: "hr" };
const juan = { provider: "p", subject: "juan" };

async function setup() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org", name: "Acme" });
  await storage.roles.create({ id: "hr", organizationId: "org", name: "HR", permissionKeys: Object.values(TEAM_PERMISSIONS) });
  await storage.memberships.create({ id: "m-hr", organizationId: "org", identity: hr, roleIds: ["hr"] });
  await storage.memberships.create({ id: "m-juan", organizationId: "org", identity: juan });
  return createTeamService({ storage });
}

describe("teamCommandRoute", () => {
  it("answers 401 without a caller", async () => {
    const teams = await setup();
    expect((await teamCommandRoute(teams, { command: "createTeam", caller: null, params: { name: "X" } })).status).toBe(401);
  });

  it("runs the command as the caller and maps refusals to a generic 403", async () => {
    const teams = await setup();
    const ok = await teamCommandRoute(teams, { command: "createTeam", caller: { actor: hr, organizationId: "org" }, params: { id: "bcn", name: "Barcelona" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: "bcn" });
    const denied = await teamCommandRoute(teams, { command: "addMember", caller: { actor: juan, organizationId: "org" }, params: { teamId: "bcn", membershipId: "m-juan" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
  });

  it("rejects fields the client must not set and rethrows what is not a team error", async () => {
    const teams = await setup();
    const bad = await teamCommandRoute(teams, { command: "createTeam", caller: { actor: hr, organizationId: "org" }, params: { name: "X", authorization: {} } });
    expect(bad.status).toBe(400);
    await expect(
      teamCommandRoute({ ...teams, createTeam: async () => { throw new Error("db down"); } }, { command: "createTeam", caller: { actor: hr, organizationId: "org" }, params: { name: "X" } }),
    ).rejects.toThrow("db down");
  });
});
