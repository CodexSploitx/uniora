import { describe, expect, it } from "vitest";
import { createAuthorizationEngine, createAuditedStorage, createMemoryStorage, createTrustedPolicyStorage, createTrustedTeamStorage, parsePolicyDefinition } from "../index.js";
import type { UnioraStorage } from "../index.js";

const system = { provider: "sys", subject: "import" };
const ana = { provider: "p", subject: "ana" }; // member of the branch
const bob = { provider: "p", subject: "bob" }; // manager of the region
const eva = { provider: "p", subject: "eva" }; // owner of the other branch
const leaders = { kind: "scope", effect: "require", actions: ["vehicles.update"], resourceType: "vehicle", condition: { intersects: [{ ref: "subject.managedTeamIds" }, { ref: "resource.teamPathIds" }] } };
const upward = { kind: "scope", effect: "require", actions: ["vehicles.read"], resourceType: "vehicle", condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamPathIds" }] } };

/** region > branch > squad, and region > other-branch. */
async function seed() {
  const storage = createMemoryStorage();
  const trusted = createTrustedPolicyStorage(createAuditedStorage(storage, { actor: system }), { actor: system, reason: "unit test" });
  const teams = createTrustedTeamStorage(storage, { actor: system, reason: "unit test" });
  await storage.organizations.create({ id: "org-1", name: "Acme" });
  await storage.organizations.create({ id: "org-2", name: "Other" });
  for (const key of ["vehicles.update", "vehicles.read"]) await storage.permissions.register({ key });
  await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["vehicles.update", "vehicles.read"] });
  for (const [id, who] of [["m-ana", ana], ["m-bob", bob], ["m-eva", eva]] as const) {
    await storage.memberships.create({ id, organizationId: "org-1", identity: who, roleIds: ["staff"] });
  }
  await teams.teams.create({ id: "region", organizationId: "org-1", name: "Region" });
  await teams.teams.create({ id: "branch", organizationId: "org-1", name: "Branch", parentId: "region" });
  await teams.teams.create({ id: "squad", organizationId: "org-1", name: "Squad", parentId: "branch" });
  await teams.teams.create({ id: "other-branch", organizationId: "org-1", name: "Other branch", parentId: "region" });
  await teams.teams.create({ id: "foreign", organizationId: "org-2", name: "Foreign" });
  await teams.teamMemberships.add({ id: "tm-ana", organizationId: "org-1", teamId: "branch", membershipId: "m-ana" });
  await teams.teamMemberships.add({ id: "tm-bob", organizationId: "org-1", teamId: "region", membershipId: "m-bob", responsibility: "manager" });
  await teams.teamMemberships.add({ id: "tm-eva", organizationId: "org-1", teamId: "other-branch", membershipId: "m-eva", responsibility: "owner" });
  const engine = createAuthorizationEngine(storage);
  return { storage, trusted, teams, engine };
}
type World = Awaited<ReturnType<typeof seed>>;

async function live(world: World, id: string, key: string, definition: unknown) {
  await world.trusted.policies.create({ id, organizationId: "org-1", key, name: key, definition, createdBy: system });
  await world.trusted.policies.activate("org-1", id, { actor: system });
}
const ask = (world: World, identity: typeof ana, teamIds: string[] | undefined, permission = "vehicles.update") =>
  world.engine.authorize({ identity, organizationId: "org-1", permission, resource: { type: "vehicle", id: "v-1", organizationId: "org-1", ...(teamIds ? { teamIds } : {}) } });

describe("the team tree in policies", () => {
  it("accepts the two new attributes in a definition", () => {
    expect(() => parsePolicyDefinition(leaders)).not.toThrow();
    expect(() => parsePolicyDefinition(upward)).not.toThrow();
  });

  it("a leader reaches everything below their team, and nobody else does", async () => {
    const world = await seed();
    await live(world, "p1", "leaders", leaders);
    expect((await ask(world, bob, ["squad"])).decision).toBe("allow"); // manager of the region, two levels above
    expect((await ask(world, bob, ["other-branch"])).decision).toBe("allow");
    expect((await ask(world, eva, ["other-branch"])).decision).toBe("allow"); // owner counts, the team itself counts
    expect((await ask(world, eva, ["squad"])).decision).toBe("deny"); // another branch of the same region
    expect((await ask(world, ana, ["squad"])).decision).toBe("deny"); // a plain member leads nothing
  });

  it("membership of a team above reaches the teams below only for policies that read the path", async () => {
    const world = await seed();
    await live(world, "p2", "upward", upward);
    expect((await ask(world, ana, ["squad"], "vehicles.read")).decision).toBe("allow");
    expect((await ask(world, ana, ["branch"], "vehicles.read")).decision).toBe("allow");
    expect((await ask(world, ana, ["other-branch"], "vehicles.read")).decision).toBe("deny");
    // A policy that compares with resource.teamIds alone gets no inheritance.
    await live(world, "p3", "flat", { kind: "scope", effect: "require", actions: ["vehicles.update"], resourceType: "vehicle", condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] } });
    expect((await ask(world, ana, ["squad"], "vehicles.update")).decision).toBe("deny");
    expect((await ask(world, ana, ["branch"], "vehicles.update")).decision).toBe("allow");
  });

  it("moving a team, or a change of responsibility or status, is seen on the next decision", async () => {
    const world = await seed();
    await live(world, "p1", "leaders", leaders);
    expect((await ask(world, eva, ["squad"])).decision).toBe("deny");
    await world.teams.teams.update("org-1", "squad", { parentId: "other-branch" });
    expect((await ask(world, eva, ["squad"])).decision).toBe("allow");
    expect((await ask(world, bob, ["squad"])).decision).toBe("allow"); // still under the region
    await world.teams.teamMemberships.setResponsibility("org-1", "tm-bob", "member", { actor: system });
    expect((await ask(world, bob, ["squad"])).decision).toBe("deny");
    await world.teams.teamMemberships.setResponsibility("org-1", "tm-bob", "manager", { actor: system });
    await world.teams.teamMemberships.setStatus("org-1", "tm-bob", "suspended", { actor: system });
    expect((await ask(world, bob, ["squad"])).decision).toBe("deny");
  });

  it("is isolated per organization: a team of another organization adds nothing", async () => {
    const world = await seed();
    await live(world, "p1", "leaders", leaders);
    const result = await ask(world, bob, ["foreign"]);
    expect(result.decision).toBe("deny");
    expect(await world.storage.teams.pathIds("org-1", ["foreign", "squad"])).toEqual(["branch", "region", "squad"]);
    expect(await world.storage.teams.pathIds("org-2", ["squad"])).toEqual([]);
  });

  it("fails closed: unknown teams, too many teams or an unreadable tree are indeterminate, never allow", async () => {
    const world = await seed();
    await live(world, "p1", "leaders", leaders);
    expect((await ask(world, bob, undefined)).decision).toBe("indeterminate"); // team unknown to the host
    expect((await ask(world, bob, [])).decision).toBe("deny"); // known to be in none
    const many = Array.from({ length: 51 }, (_, index) => `t${index}`);
    expect(await ask(world, bob, many)).toMatchObject({ decision: "indeterminate", policies: [{ reason: "team_tree_unavailable" }] });
    const broken: UnioraStorage = { ...world.storage, teams: { ...world.storage.teams, pathIds: async () => { throw new Error("db down"); } } };
    const engine = createAuthorizationEngine(broken);
    const result = await engine.authorize({ identity: bob, organizationId: "org-1", permission: "vehicles.update", resource: { type: "vehicle", id: "v", organizationId: "org-1", teamIds: ["squad"] } });
    expect(result).toMatchObject({ decision: "indeterminate", allowed: false, policies: [{ reason: "team_tree_unavailable" }] });
  });

  it("the path is only looked up when a policy reads it", async () => {
    const world = await seed();
    let lookups = 0;
    const counting: UnioraStorage = { ...world.storage, teams: { ...world.storage.teams, pathIds: async (...args) => { lookups++; return world.storage.teams.pathIds(...args); } } };
    await live(world, "p3", "flat", { kind: "scope", effect: "require", actions: ["vehicles.update"], resourceType: "vehicle", condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] } });
    await createAuthorizationEngine(counting).authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: { type: "vehicle", id: "v", organizationId: "org-1", teamIds: ["branch"] } });
    expect(lookups).toBe(0);
  });

  it("validates the arguments of the team repository the same way everywhere", async () => {
    const world = await seed();
    await expect(world.storage.teams.pathIds("org-1", Array.from({ length: 51 }, (_, i) => `t${i}`))).rejects.toMatchObject({ code: "team_invalid" });
    await expect(world.storage.teamMemberships.activeTeamIds("org-1", "m-bob", { responsibilities: [] })).rejects.toMatchObject({ code: "team_membership_invalid" });
    await expect(world.storage.teamMemberships.activeTeamIds("org-1", "m-bob", { responsibilities: ["boss" as never] })).rejects.toMatchObject({ code: "team_membership_invalid" });
    expect(await world.storage.teamMemberships.activeTeamIds("org-1", "m-bob", { responsibilities: ["owner", "manager"] })).toEqual(["region"]);
    expect(await world.storage.teamMemberships.activeTeamIds("org-1", "m-ana", { responsibilities: ["owner", "manager"] })).toEqual([]);
  });
});
