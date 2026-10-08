import { describe, expect, it } from "vitest";
import { TeamError, createMemoryStorage, createTrustedTeamStorage, resolveTeamSlug, sameTeamData, sanitizeTeamData } from "../index.js";
import { issueTeamAuthorization } from "./authorization.js";

const actor = { provider: "p", subject: "admin" };
const ana = { provider: "p", subject: "ana" };

const trusted = (raw: ReturnType<typeof createMemoryStorage>) => createTrustedTeamStorage(raw, { actor, reason: "unit test" });

async function seed() {
  const raw = createMemoryStorage();
  const storage = raw;
  await storage.organizations.create({ id: "org-1", name: "Acme" });
  await storage.organizations.create({ id: "org-2", name: "Other" });
  await storage.roles.create({ id: "sales", organizationId: "org-1", name: "Sales" });
  await storage.roles.create({ id: "sales-2", organizationId: "org-2", name: "Sales" });
  await storage.roles.createOwnerRole({ id: "owner", organizationId: "org-1" });
  await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana });
  return Object.assign(trusted(raw), { raw });
}

const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof TeamError ? error.code : String(error)));

describe("team validation helpers", () => {
  it("derives and validates slugs", () => {
    expect(resolveTeamSlug("Barcelona Sales")).toBe("barcelona-sales");
    expect(resolveTeamSlug("x", "mad")).toBe("mad");
    expect(() => resolveTeamSlug("x", "Bad Slug")).toThrow(TeamError);
    expect(() => resolveTeamSlug("!!!")).toThrow(TeamError);
  });

  it("accepts only plain JSON data within the size limit, and returns a copy", () => {
    const input = { a: { b: [1, "x", null, true] } };
    const copy = sanitizeTeamData(input, "metadata");
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    for (const bad of [[], "text", null, { when: new Date() }, { fn: () => 1 }, { n: Number.NaN }, { big: "x".repeat(17 * 1024) }]) {
      expect(() => sanitizeTeamData(bad, "metadata")).toThrow(TeamError);
    }
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let level = 0; level < 12; level++) cursor = (cursor.next = {}) as Record<string, unknown>;
    expect(() => sanitizeTeamData(deep, "settings")).toThrow(TeamError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sanitizeTeamData(cyclic, "settings")).toThrow(TeamError);
  });

  it("compares data without caring about key order", () => {
    expect(sameTeamData({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameTeamData({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("in-memory teams", () => {
  it("never lets a team id cross organizations", async () => {
    const storage = await seed();
    await storage.teams.create({ id: "t1", organizationId: "org-1", name: "Barcelona" });
    expect(await storage.teams.findById("org-2", "t1")).toBeNull();
    expect(await code(storage.teams.update("org-2", "t1", { name: "x" }))).toBe("team_not_found");
    expect(await code(storage.teamMemberships.add({ id: "tm", organizationId: "org-2", teamId: "t1", membershipId: "m-ana" }))).toBe("team_not_found");
    expect(await code(storage.teamMemberships.add({ id: "tm", organizationId: "org-1", teamId: "t1", membershipId: "nope" }))).toBe("team_member_unknown");
  });

  it("scopes slug and external id per organization and keeps lifecycle rules", async () => {
    const storage = await seed();
    await storage.teams.create({ id: "t1", organizationId: "org-1", name: "Barcelona", externalId: "b1" });
    expect(await code(storage.teams.create({ id: "t2", organizationId: "org-1", name: "Barcelona" }))).toBe("team_slug_taken");
    expect(await code(storage.teams.create({ id: "t2", organizationId: "org-1", name: "Other", externalId: "b1" }))).toBe("team_external_id_taken");
    await storage.teams.create({ id: "t3", organizationId: "org-2", name: "Barcelona", externalId: "b1" });
    expect(await code(storage.teams.delete("org-1", "t1"))).toBe("team_not_archived");
    await storage.teams.archive("org-1", "t1", { actor });
    expect(await code(storage.teams.update("org-1", "t1", { name: "x" }))).toBe("team_archived");
    await storage.teams.delete("org-1", "t1");
    expect(await storage.teams.findById("org-1", "t1")).toBeNull();
  });

  it("returns copies, so mutating a result never changes the store", async () => {
    const storage = await seed();
    const team = await storage.teams.create({ id: "t1", organizationId: "org-1", name: "Barcelona", metadata: { a: 1 } });
    (team.metadata as Record<string, unknown>).a = 2;
    expect((await storage.teams.findById("org-1", "t1"))?.metadata).toEqual({ a: 1 });
    const row = await storage.teamMemberships.add({ id: "tm", organizationId: "org-1", teamId: "t1", membershipId: "m-ana", roleIds: ["sales"] });
    row.roleIds.push("hack");
    expect((await storage.teamMemberships.findById("org-1", "tm"))?.roleIds).toEqual(["sales"]);
  });

  it("keeps roles inside the organization, refuses the Owner role and clears them on removal", async () => {
    const storage = await seed();
    await storage.teams.create({ id: "t1", organizationId: "org-1", name: "Barcelona" });
    expect(await code(storage.teamMemberships.add({ id: "tm", organizationId: "org-1", teamId: "t1", membershipId: "m-ana", roleIds: ["sales-2"] }))).toBe("team_role_invalid");
    expect(await code(storage.teamMemberships.add({ id: "tm", organizationId: "org-1", teamId: "t1", membershipId: "m-ana", roleIds: ["owner"] }))).toBe("team_role_owner_protected");
    await storage.teamMemberships.add({ id: "tm", organizationId: "org-1", teamId: "t1", membershipId: "m-ana", roleIds: ["sales"] });
    await expect(storage.roles.delete("sales", { members: "reject" })).rejects.toMatchObject({ code: "role_in_use" });
    const removed = await storage.teamMemberships.setStatus("org-1", "tm", "removed", { actor });
    expect(removed.roleIds).toEqual([]);
    await storage.roles.delete("sales", { members: "reject" });
  });
});

describe("team writes need an authorization the storage can verify", () => {
  async function bare() {
    const storage = await seed();
    await storage.teams.create({ id: "t1", organizationId: "org-1", name: "Barcelona" });
    await storage.teamMemberships.add({ id: "tm", organizationId: "org-1", teamId: "t1", membershipId: "m-ana" });
    return storage;
  }
  const missing = (call: () => Promise<unknown>) => expect(call()).rejects.toMatchObject({ code: "team_authorization_required" });

  it("refuses every write without it, with a forged one, or with a copy of a real one", async () => {
    const { raw } = await bare();
    const real = issueTeamAuthorization("org-1", actor, ["team.update", "member.role"]);
    const forged = { organizationId: "org-1", actor, operations: ["team.update"] } as never;
    const copy = { ...real } as never;
    const attempts: Array<[string, (authorization: never) => Promise<unknown>]> = [
      ["teams.create", (a) => raw.teams.create({ id: "t2", organizationId: "org-1", name: "Two", authorization: a })],
      ["teams.update", (a) => raw.teams.update("org-1", "t1", { name: "x", authorization: a })],
      ["teams.archive", (a) => raw.teams.archive("org-1", "t1", { actor, authorization: a })],
      ["teams.restore", (a) => raw.teams.restore("org-1", "t1", { actor, authorization: a })],
      ["teams.delete", (a) => raw.teams.delete("org-1", "t1", { authorization: a })],
      ["teamMemberships.add", (a) => raw.teamMemberships.add({ id: "tm2", organizationId: "org-1", teamId: "t1", membershipId: "m-ana", authorization: a })],
      ["teamMemberships.setStatus", (a) => raw.teamMemberships.setStatus("org-1", "tm", "suspended", { actor, authorization: a })],
      ["teamMemberships.accept", (a) => raw.teamMemberships.accept("org-1", "tm", { actor: ana, authorization: a })],
      ["teamMemberships.setResponsibility", (a) => raw.teamMemberships.setResponsibility("org-1", "tm", "manager", { authorization: a })],
      ["teamMemberships.assignRole", (a) => raw.teamMemberships.assignRole("org-1", "tm", "nope", { authorization: a })],
      ["teamMemberships.unassignRole", (a) => raw.teamMemberships.unassignRole("org-1", "tm", "nope", { authorization: a })],
    ];
    for (const [name, attempt] of attempts) {
      for (const bad of [undefined, null, {}, "token", forged, copy] as never[]) {
        await expect(attempt(bad), `${name} with ${JSON.stringify(bad)}`).rejects.toMatchObject({ code: "team_authorization_required" });
      }
    }
    expect((await raw.teams.findById("org-1", "t1"))?.name).toBe("Barcelona");
    expect(real).toBeTruthy();
  });

  it("a real token only works for its own organization, operation and actor, and not after it expires", async () => {
    const { raw } = await bare();
    const update = issueTeamAuthorization("org-1", actor, ["team.update"]);
    await missing(() => raw.teams.archive("org-1", "t1", { actor, authorization: update })); // another operation
    await missing(() => raw.teams.update("org-2", "t1", { name: "x", authorization: update })); // another organization
    const archive = issueTeamAuthorization("org-1", actor, ["team.archive"]);
    await missing(() => raw.teams.archive("org-1", "t1", { actor: ana, authorization: archive })); // another actor
    const stale = issueTeamAuthorization("org-1", actor, ["team.update"], { now: Date.now() - 61_000 });
    await missing(() => raw.teams.update("org-1", "t1", { name: "x", authorization: stale }));
    expect((await raw.teams.update("org-1", "t1", { name: "Renamed", authorization: update })).name).toBe("Renamed");
  });

  it("the trusted wrapper needs a reason and still applies every other rule", async () => {
    const raw = createMemoryStorage();
    expect(() => createTrustedTeamStorage(raw, { actor, reason: "  " })).toThrow(TeamError);
    const { teams } = await bare();
    await expect(teams.create({ id: "t1", organizationId: "org-1", name: "Dup" })).rejects.toMatchObject({ code: "team_exists" });
  });
});
