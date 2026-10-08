import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { TEAM_PERMISSIONS, createMemoryStorage, createTeamService } from "@uniora/core";
import { teamCommand } from "./teams.js";

const hr = { provider: "p", subject: "hr" };
const juan = { provider: "p", subject: "juan" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org", name: "Acme" });
  await storage.roles.create({ id: "hr", organizationId: "org", name: "HR", permissionKeys: Object.values(TEAM_PERMISSIONS) });
  await storage.memberships.create({ id: "m-hr", organizationId: "org", identity: hr, roleIds: ["hr"] });
  await storage.memberships.create({ id: "m-juan", organizationId: "org", identity: juan });
  const teams = createTeamService({ storage });
  const resolve = (req: { header(name: string): string | undefined }) => {
    const who = req.header("x-test-user");
    return who === "hr" ? { actor: hr, organizationId: "org" } : who === "juan" ? { actor: juan, organizationId: "org" } : null;
  };
  const app = express();
  app.use(express.json());
  app.post("/teams", teamCommand(teams, { command: "createTeam", resolve }));
  app.post("/teams/:teamId/members", teamCommand(teams, { command: "addMember", resolve }));
  const server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const post = (url: string, user: string | null, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: JSON.stringify(body) });

describe("teamCommand", () => {
  it("answers 401 without a caller", async () => {
    const { base } = await serve();
    expect((await post(`${base}/teams`, null, { name: "Barcelona" })).status).toBe(401);
  });

  it("creates a team and adds a member; the path wins over the body", async () => {
    const { base } = await serve();
    const created = await post(`${base}/teams`, "hr", { id: "bcn", name: "Barcelona" });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ id: "bcn", name: "Barcelona" });
    const added = await post(`${base}/teams/bcn/members`, "hr", { membershipId: "m-juan", teamId: "somewhere-else" });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ teamId: "bcn", membershipId: "m-juan", status: "active" });
  });

  it("refuses a caller without the right with a generic 403, and rejects fields the client must not set", async () => {
    const { base } = await serve();
    const denied = await post(`${base}/teams`, "juan", { name: "Mine" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
    const smuggled = await post(`${base}/teams`, "juan", { name: "Mine", actor: { provider: "p", subject: "hr" } });
    expect(smuggled.status).toBe(400);
    const crossOrg = await post(`${base}/teams`, "hr", { name: "X", organizationId: "other" });
    expect(crossOrg.status).toBe(400);
  });
});
