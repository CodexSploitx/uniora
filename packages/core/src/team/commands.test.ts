import { describe, expect, it } from "vitest";
import { TEAM_PERMISSIONS, TeamError, createMemoryStorage, createTeamService, createTrustedTeamStorage, runTeamCommand, teamErrorToHttp } from "../index.js";

const boss = { provider: "p", subject: "boss" };
const hr = { provider: "p", subject: "hr" };
const juan = { provider: "p", subject: "juan" };

async function setup() {
  const raw = createMemoryStorage();
  const storage = createTrustedTeamStorage(raw, { actor: boss, reason: "unit test fixtures" });
  await storage.organizations.create({ id: "org", name: "Acme" });
  await storage.roles.create({ id: "hr", organizationId: "org", name: "HR", permissionKeys: Object.values(TEAM_PERMISSIONS) });
  await storage.memberships.create({ id: "m-hr", organizationId: "org", identity: hr, roleIds: ["hr"] });
  await storage.memberships.create({ id: "m-juan", organizationId: "org", identity: juan });
  return { service: createTeamService({ storage: raw }), raw };
}

const run = (service: ReturnType<typeof createTeamService>, command: string, actor: typeof hr, params: unknown) =>
  runTeamCommand(service, command, { actor, organizationId: "org" }, params);
const outcome = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof TeamError ? error.code : String(error)));

describe("runTeamCommand", () => {
  it("runs a command as the caller, with JSON-safe results and generated ids", async () => {
    const { service } = await setup();
    const team = (await run(service, "createTeam", hr, { name: "Barcelona", metadata: { type: "branch" } })) as { id: string; createdAt: string; name: string };
    expect(team.name).toBe("Barcelona");
    expect(typeof team.id).toBe("string");
    expect(typeof team.createdAt).toBe("string");
    const row = (await run(service, "addMember", hr, { teamId: team.id, membershipId: "m-juan" })) as { status: string };
    expect(row.status).toBe("active");
  });

  it("the service still decides: a caller without the right is refused", async () => {
    const { service } = await setup();
    expect(await outcome(run(service, "createTeam", juan, { name: "Mine" }))).toBe("team_forbidden");
  });

  it("rejects unknown commands and any field the command does not declare (no actor, authorization or organization from the body)", async () => {
    const { service } = await setup();
    expect(await outcome(run(service, "dropEverything", hr, {}))).toBe("team_invalid");
    expect(await outcome(run(service, "createTeam", juan, { name: "X", actor: hr }))).toBe("team_invalid");
    expect(await outcome(run(service, "createTeam", hr, { name: "X", organizationId: "other" }))).toBe("team_invalid");
    expect(await outcome(run(service, "createTeam", hr, { name: "X", authorization: {} }))).toBe("team_invalid");
    expect(await outcome(run(service, "createTeam", hr, { name: 5 }))).toBe("team_invalid");
    expect(await outcome(run(service, "createTeam", hr, null))).toBe("team_invalid");
    expect(await outcome(run(service, "addMember", hr, { teamId: "t", membershipId: "m", responsibility: "boss" }))).toBe("team_invalid");
    expect(await outcome(run(service, "updateTeam", hr, { teamId: "t", expectedVersion: -1 }))).toBe("team_invalid");
  });
});

describe("teamErrorToHttp", () => {
  it("maps refusals, missing rows, conflicts and bad input; ignores everything else", () => {
    const http = (code: ConstructorParameters<typeof TeamError>[1]) => teamErrorToHttp(new TeamError("m", code));
    expect(http("team_forbidden")).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(http("team_accept_forbidden")?.status).toBe(403);
    expect(http("team_not_found")?.status).toBe(404);
    expect(http("team_slug_taken")?.status).toBe(409);
    expect(http("team_version_conflict")?.status).toBe(409);
    expect(http("team_name_invalid")?.status).toBe(400);
    expect(http("team_authorization_required")).toMatchObject({ status: 500, body: { message: "Something went wrong." } });
    expect(teamErrorToHttp(new Error("boom"))).toBeNull();
  });
});
