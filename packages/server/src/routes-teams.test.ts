import { afterEach, describe, expect, it } from "vitest";
import { startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});
async function start(name: BackendName) {
  const f = await startFixture(name);
  open.push(f);
  const { token } = await f.issue();
  const as = (actor: string) => (method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => f.call(method, path, { token, actor, ...init });
  return { f, token, as };
}
const ORG = "/v1/organizations/org_acme";

describe.each(["memory", "sqlite"] as const)("team routes over %s", (backend) => {
  it("creates, reads, edits, archives, restores and deletes a team", async () => {
    const { f, token, as } = await start(backend);
    const mgr = as("mgr");
    const created = await mgr("POST", `${ORG}/teams`, { body: { name: "Barcelona", metadata: { region: "ES" } } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Barcelona", slug: "barcelona", status: "active", metadata: { region: "ES" }, version: 1 });
    const teamId = created.body.id as string;
    expect(created.headers.get("location")).toBe(`${ORG}/teams/${teamId}`);

    const read = await f.call("GET", `${ORG}/teams/${teamId}`, { token });
    expect(read.body.id).toBe(teamId);
    expect(read.headers.get("etag")).toBe('"1"');
    expect((await f.call("GET", `/v1/organizations/org_globex/teams/${teamId}`, { token })).body.code).toBe("team_not_found");

    const child = await mgr("POST", `${ORG}/teams`, { body: { name: "Sants", parentId: teamId } });
    expect(child.body.parentId).toBe(teamId);
    expect((await f.call("GET", `${ORG}/teams?parentId=${teamId}`, { token })).body.items.map((t: { id: string }) => t.id)).toEqual([child.body.id]);
    expect((await mgr("DELETE", `${ORG}/teams/${teamId}`)).body.code).toBe("team_not_archived");

    const renamed = await mgr("PATCH", `${ORG}/teams/${teamId}`, { body: { name: "BCN", externalId: "ERP-7" } });
    expect(renamed.body).toMatchObject({ name: "BCN", externalId: "ERP-7", version: 2 });
    expect((await mgr("PATCH", `${ORG}/teams/${teamId}`, { body: { name: "Old" }, headers: { "if-match": '"1"' } })).status).toBe(412);
    expect((await mgr("PATCH", `${ORG}/teams/${teamId}`, { body: { externalId: null } })).body.externalId).toBeUndefined();

    expect((await mgr("POST", `${ORG}/teams/${teamId}/archive`, { body: {} })).body.code).toBe("team_has_children");
    const childId = child.body.id as string;
    const archived = await mgr("POST", `${ORG}/teams/${childId}/archive`, { body: { reason: "closed" } });
    expect(archived.body).toMatchObject({ status: "archived", archived: { reason: "closed" } });
    expect((await mgr("POST", `${ORG}/teams/${childId}/restore`)).body.status).toBe("active");
    await mgr("POST", `${ORG}/teams/${childId}/archive`, { body: {} });

    expect((await mgr("DELETE", `${ORG}/teams/${teamId}`)).body.code).toBe("team_not_archived");
    expect((await mgr("DELETE", `${ORG}/teams/${childId}`)).body).toEqual({ deleted: true });
    await mgr("POST", `${ORG}/teams/${teamId}/archive`, { body: {} });
    expect((await mgr("DELETE", `${ORG}/teams/${teamId}`)).body).toEqual({ deleted: true });
  });

  it("refuses an end user without the team permission, as a plain 403", async () => {
    const { as } = await start(backend);
    const response = await as("ana")("POST", `${ORG}/teams`, { body: { name: "Nope" } });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("forbidden");
  });

  it("adds, invites, accepts, moves, suspends and removes team members, and sets roles and responsibility", async () => {
    const { f, token, as } = await start(backend);
    const mgr = as("mgr");
    const a = (await mgr("POST", `${ORG}/teams`, { body: { name: "Alpha" } })).body.id as string;
    const b = (await mgr("POST", `${ORG}/teams`, { body: { name: "Beta" } })).body.id as string;

    const added = await mgr("POST", `${ORG}/teams/${a}/members`, { body: { membershipId: "mem_ana" } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ teamId: a, membershipId: "mem_ana", status: "active", responsibility: "member" });

    const invited = await mgr("POST", `${ORG}/teams/${a}/members`, { body: { membershipId: "mem_bob", status: "pending" } });
    expect(invited.body.status).toBe("pending");
    // Only the invited person accepts.
    expect((await mgr("POST", `${ORG}/team-memberships/${invited.body.id}/accept`)).status).toBe(403);
    expect((await as("bob")("POST", `${ORG}/team-memberships/${invited.body.id}/accept`)).body.status).toBe("active");

    const listed = await f.call("GET", `${ORG}/teams/${a}/members?status=active`, { token });
    expect(listed.body.items).toHaveLength(2);

    expect((await mgr("PUT", `${ORG}/team-memberships/${added.body.id}/responsibility`, { body: { responsibility: "manager" } })).body.responsibility).toBe("manager");
    expect((await mgr("PUT", `${ORG}/team-memberships/${added.body.id}/roles/role_viewer`)).body.roleIds).toEqual(["role_viewer"]);
    expect((await mgr("DELETE", `${ORG}/team-memberships/${added.body.id}/roles/role_viewer`)).body.roleIds).toEqual([]);

    expect((await mgr("POST", `${ORG}/team-memberships/${added.body.id}/suspend`, { body: { reason: "leave" } })).body.status).toBe("suspended");
    expect((await mgr("POST", `${ORG}/team-memberships/${added.body.id}/reactivate`)).body.status).toBe("active");

    const moved = await mgr("POST", `${ORG}/team-moves`, { body: { membershipId: "mem_ana", fromTeamId: a, toTeamId: b } });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ teamId: b, membershipId: "mem_ana" });

    expect((await mgr("DELETE", `${ORG}/team-memberships/${invited.body.id}?reason=left`)).body.status).toBe("removed");
    expect((await as("ana")("POST", `${ORG}/teams/${b}/leave`)).body.status).toBe("removed");
  });

  it("answers 404 for a team or membership of another organization, and keeps its audit entries stamped", async () => {
    const { f, as } = await start(backend);
    const mgr = as("mgr");
    expect((await mgr("POST", `${ORG}/teams/nope/archive`, { body: {} })).body.code).toBe("team_not_found");
    expect((await mgr("POST", `${ORG}/team-memberships/nope/suspend`, { body: {} })).body.code).toBe("team_membership_not_found");
    const created = await mgr("POST", `${ORG}/teams`, { body: { name: "Gamma" } });
    const entries = await f.backend.storage.auditLogs.search({ organizationId: "org_acme", action: "team.created" });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.metadata?.via).toMatchObject({ requestId: created.headers.get("request-id") });
  });
});
