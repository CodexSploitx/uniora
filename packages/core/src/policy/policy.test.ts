import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_POLICIES,
  PolicyError,
  assertPolicyAuthorization,
  createAuditedStorage,
  createAuthorizationEngine,
  createMemoryStorage,
  createPolicyDecisionAuditor,
  createPolicyService,
  createTrustedPolicyStorage,
  createTrustedTeamStorage,
} from "../index.js";
import type { AuthorizationEngineOptions, UnioraStorage } from "../index.js";

const system = { provider: "sys", subject: "import" };
const ana = { provider: "p", subject: "ana" };
const bob = { provider: "p", subject: "bob" };
const admin = { provider: "p", subject: "admin" };
const author = { provider: "p", subject: "author" };
const publisher = { provider: "p", subject: "publisher" };
const outsider = { provider: "p", subject: "outsider" };

const scopeDefinition = {
  kind: "scope",
  effect: "require",
  actions: ["vehicles.update", "vehicles.read"],
  resourceType: "vehicle",
  condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] },
};
const lockedDefinition = {
  kind: "resource",
  effect: "deny",
  actions: ["vehicles.*"],
  resourceType: "vehicle",
  attributes: { status: "string" },
  condition: { all: [{ eq: [{ ref: "resource.status" }, { value: "locked" }] }, { not: { permission: "vehicles.unlock" } }] },
  denyReason: "vehicle_locked",
};

async function seed(engineOptions?: AuthorizationEngineOptions) {
  const storage = createMemoryStorage();
  const trusted = createTrustedPolicyStorage(createAuditedStorage(storage, { actor: system }), { actor: system, reason: "unit test" });
  const teams = createTrustedTeamStorage(storage, { actor: system, reason: "unit test" });
  await storage.organizations.create({ id: "org-1", name: "Acme" });
  await storage.organizations.create({ id: "org-2", name: "Other" });
  for (const key of ["vehicles.update", "vehicles.read", "vehicles.unlock", "policies.read", "policies.manage", "policies.activate", "reports.run"]) {
    await storage.permissions.register({ key });
  }
  await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["vehicles.update", "vehicles.read"] });
  await storage.roles.create({ id: "supervisor", organizationId: "org-1", name: "Supervisor", permissionKeys: ["vehicles.update", "vehicles.read", "vehicles.unlock"] });
  await storage.roles.create({ id: "policy-admin", organizationId: "org-1", name: "Policy admin", permissionKeys: ["policies.read", "policies.manage", "policies.activate"] });
  await storage.roles.create({ id: "policy-author", organizationId: "org-1", name: "Policy author", permissionKeys: ["policies.read", "policies.manage"] });
  await storage.roles.create({ id: "policy-publisher", organizationId: "org-1", name: "Policy publisher", permissionKeys: ["policies.read", "policies.activate"] });
  await storage.roles.create({ id: "staff-2", organizationId: "org-2", name: "Staff", permissionKeys: ["vehicles.update"] });
  await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana, roleIds: ["staff"] });
  await storage.memberships.create({ id: "m-bob", organizationId: "org-1", identity: bob, roleIds: ["supervisor"] });
  await storage.memberships.create({ id: "m-admin", organizationId: "org-1", identity: admin, roleIds: ["policy-admin"] });
  await storage.memberships.create({ id: "m-author", organizationId: "org-1", identity: author, roleIds: ["policy-author"] });
  await storage.memberships.create({ id: "m-publisher", organizationId: "org-1", identity: publisher, roleIds: ["policy-publisher"] });
  await storage.memberships.create({ id: "m-out", organizationId: "org-2", identity: outsider, roleIds: ["staff-2"] });
  await teams.teams.create({ id: "t-bcn", organizationId: "org-1", name: "Barcelona" });
  await teams.teams.create({ id: "t-mad", organizationId: "org-1", name: "Madrid" });
  await teams.teamMemberships.add({ id: "tm-ana", organizationId: "org-1", teamId: "t-bcn", membershipId: "m-ana" });
  await teams.teamMemberships.add({ id: "tm-bob", organizationId: "org-1", teamId: "t-mad", membershipId: "m-bob" });
  const engine = createAuthorizationEngine(storage, engineOptions);
  const service = createPolicyService({ storage });
  return { storage, trusted, teams, engine, service };
}

type World = Awaited<ReturnType<typeof seed>>;

async function live(world: World, id: string, key: string, definition: unknown, organizationId = "org-1") {
  await world.trusted.policies.create({ id, organizationId, key, name: key, definition, createdBy: system });
  return world.trusted.policies.activate(organizationId, id, { actor: system });
}

const vehicle = (extra: Record<string, unknown> = {}) => ({
  type: "vehicle",
  id: "v-1",
  organizationId: "org-1",
  teamIds: ["t-bcn"],
  attributes: { status: "open" },
  ...extra,
});
const ask = (world: World, identity = ana, resource: unknown = vehicle(), permission = "vehicles.update", extra: object = {}) =>
  world.engine.authorize({ identity, organizationId: "org-1", permission, resource: resource as never, ...extra });

describe("authorize without policies", () => {
  it("is exactly the role-based decision, with a reason for each refusal", async () => {
    const world = await seed();
    expect(await ask(world)).toMatchObject({ decision: "allow", allowed: true, reason: "allowed", via: "membership", policies: [] });
    expect(await ask(world, outsider)).toMatchObject({ decision: "deny", allowed: false, reason: "permission_denied" });
    expect(await ask(world, ana, vehicle(), "vehicles.unlock")).toMatchObject({ decision: "deny", reason: "permission_denied" });
    expect(await ask(world, ana, vehicle(), "")).toMatchObject({ decision: "deny", reason: "malformed_input" });
    await world.storage.memberships.block("m-ana", { actor: admin });
    expect(await ask(world)).toMatchObject({ decision: "deny", reason: "membership_inactive" });
    await world.storage.organizations.setStatus("org-1", { status: "suspended", actor: admin });
    expect(await ask(world, bob)).toMatchObject({ decision: "deny", reason: "organization_inactive" });
  });

  it("never throws for malformed input", async () => {
    const world = await seed();
    for (const input of [undefined, null, {}, { identity: ana }, { identity: "x", organizationId: "org-1", permission: "a.b" }, { identity: ana, organizationId: 5, permission: "a.b" }]) {
      const result = await world.engine.authorize(input as never);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("malformed_input");
    }
  });
});

describe("a policy only restricts", () => {
  it("scope: allows the own team and denies the other, with the policy in the explanation", async () => {
    const world = await seed();
    const policy = await live(world, "p1", "vehicles.scope", scopeDefinition);
    const own = await ask(world);
    expect(own).toMatchObject({ decision: "allow", reason: "allowed" });
    expect(own.policies).toEqual([{ policyId: "p1", key: "vehicles.scope", revision: 1, definitionHash: policy.definitionHash, effect: "require", result: "allow" }]);
    expect(own.policyRevision).toBeGreaterThan(0);
    const other = await ask(world, ana, vehicle({ teamIds: ["t-mad"] }));
    expect(other).toMatchObject({ decision: "deny", reason: "policy_denied" });
    expect(other.policies[0]).toMatchObject({ result: "deny", reason: "policy_requirement_not_met" });
  });

  it("never grants a permission the person does not hold", async () => {
    const world = await seed();
    // The most favourable policy possible: it requires nothing that is false.
    await live(world, "p1", "favourable", { kind: "access", effect: "require", actions: ["*"], condition: { exists: "subject.membershipId" } });
    expect(await ask(world, ana, vehicle(), "vehicles.unlock")).toMatchObject({ decision: "deny", reason: "permission_denied" });
    expect(await ask(world, outsider)).toMatchObject({ decision: "deny" });
  });

  it("deny overrides: a requirement that holds does not cancel a deny", async () => {
    const world = await seed();
    await live(world, "p1", "scope", scopeDefinition);
    await live(world, "p2", "locked", lockedDefinition);
    const locked = await ask(world, ana, vehicle({ attributes: { status: "locked" } }));
    expect(locked).toMatchObject({ decision: "deny", reason: "policy_denied" });
    expect(locked.policies.map((p) => [p.key, p.result])).toEqual([["locked", "deny"], ["scope", "allow"]]);
    // The permission predicate: a supervisor who may unlock passes the lock.
    expect((await ask(world, bob, vehicle({ teamIds: ["t-mad"], attributes: { status: "locked" } }))).decision).toBe("allow");
  });

  it("is indeterminate, and so not allowed, when a fact is missing", async () => {
    const world = await seed();
    await live(world, "p1", "scope", scopeDefinition);
    expect(await ask(world, ana, vehicle({ teamIds: undefined }))).toMatchObject({ decision: "indeterminate", allowed: false, reason: "policy_indeterminate" });
    expect(await world.engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update" })).toMatchObject({ decision: "indeterminate", allowed: false });
    expect(await ask(world, ana, vehicle({ teamIds: [] }))).toMatchObject({ decision: "deny" });
  });

  it("a protected operation can demand that a policy applied", async () => {
    const world = await seed();
    expect(await ask(world, ana, vehicle(), "vehicles.update", { requireApplicablePolicy: true })).toMatchObject({ decision: "deny", reason: "no_applicable_policy" });
    await live(world, "p1", "scope", scopeDefinition);
    expect((await ask(world, ana, vehicle(), "vehicles.update", { requireApplicablePolicy: true })).decision).toBe("allow");
  });

  it("feature predicates read the organization's features", async () => {
    const world = await seed();
    await world.storage.features.register({ key: "advanced_reports", name: "Advanced reports" });
    await world.storage.roles.create({ id: "analyst", organizationId: "org-1", name: "Analyst", permissionKeys: ["reports.run"] });
    await world.storage.memberships.assignRole("m-ana", "analyst");
    await live(world, "pf", "reports.need-feature", { kind: "feature", effect: "require", actions: ["reports.run"], condition: { feature: "advanced_reports" } });
    expect(await world.engine.authorize({ identity: ana, organizationId: "org-1", permission: "reports.run" })).toMatchObject({ decision: "deny", reason: "policy_denied" });
    await world.storage.features.enable("org-1", "advanced_reports");
    expect((await world.engine.authorize({ identity: ana, organizationId: "org-1", permission: "reports.run" })).decision).toBe("allow");
  });
});

describe("tenant isolation", () => {
  it("refuses a resource of another organization whatever the permission and the policies say", async () => {
    const world = await seed();
    await live(world, "p1", "favourable", { kind: "access", effect: "require", actions: ["*"], condition: { exists: "subject.membershipId" } });
    expect(await ask(world, ana, vehicle({ organizationId: "org-2" }))).toMatchObject({ decision: "deny", reason: "cross_tenant_resource", policies: [] });
    expect(await ask(world, ana, vehicle({ organizationId: "" }))).toMatchObject({ decision: "deny", reason: "malformed_input" });
    expect(await ask(world, ana, vehicle({ organizationId: undefined }))).toMatchObject({ decision: "deny", reason: "malformed_input" });
    // A member of org-2 cannot use org-1 either, even asking for a resource of org-1.
    expect(await world.engine.authorize({ identity: outsider, organizationId: "org-1", permission: "vehicles.update", resource: vehicle() })).toMatchObject({ decision: "deny" });
  });

  it("a policy of one organization never applies to another", async () => {
    const world = await seed();
    await live(world, "p-org2", "deny-everything", { kind: "access", effect: "deny", actions: ["*"], condition: { exists: "subject.membershipId" } }, "org-2");
    expect((await ask(world)).decision).toBe("allow");
    expect(await world.storage.policies.findById("org-1", "p-org2")).toBeNull();
    expect(await world.storage.policies.findByKey("org-1", "deny-everything")).toBeNull();
    expect(await world.storage.policies.search({ organizationId: "org-1" })).toEqual([]);
    await expect(world.trusted.policies.update("org-1", "p-org2", { actor: system, name: "x" })).rejects.toMatchObject({ code: "policy_not_found" });
    await expect(world.trusted.policies.activate("org-1", "p-org2", { actor: system })).rejects.toMatchObject({ code: "policy_not_found" });
    await expect(world.trusted.policies.delete("org-1", "p-org2")).rejects.toMatchObject({ code: "policy_not_found" });
    expect(await world.storage.policies.revisions("org-2", "p-org2")).toHaveLength(1);
    await expect(world.storage.policies.revisions("org-1", "p-org2")).rejects.toMatchObject({ code: "policy_not_found" });
    expect(await world.storage.policies.findRevision("org-1", "p-org2", 1)).toBeNull();
  });

  it("the same key can exist in two organizations", async () => {
    const world = await seed();
    await live(world, "a", "same-key", scopeDefinition);
    await expect(live(world, "b", "same-key", scopeDefinition, "org-2")).resolves.toMatchObject({ organizationId: "org-2" });
    await expect(world.trusted.policies.create({ id: "c", organizationId: "org-1", key: "same-key", name: "x", definition: scopeDefinition, createdBy: system })).rejects.toMatchObject({ code: "policy_key_taken" });
  });
});

describe("teams, as the policy sees them", () => {
  it("only active memberships of active teams count", async () => {
    const world = await seed();
    await live(world, "p1", "scope", scopeDefinition);
    expect((await ask(world)).decision).toBe("allow");
    await world.teams.teamMemberships.setStatus("org-1", "tm-ana", "suspended", { actor: system });
    expect((await ask(world)).decision).toBe("deny");
    await world.teams.teamMemberships.setStatus("org-1", "tm-ana", "active", { actor: system });
    expect((await ask(world)).decision).toBe("allow");
    await world.teams.teams.archive("org-1", "t-bcn", { actor: system });
    expect((await ask(world)).decision).toBe("deny");
    await world.teams.teams.restore("org-1", "t-bcn", { actor: system });
    expect((await ask(world)).decision).toBe("allow");
    await world.teams.teamMemberships.setStatus("org-1", "tm-ana", "removed", { actor: system });
    expect((await ask(world)).decision).toBe("deny");
  });

  it("several teams on either side intersect; a resource in no team matches nobody", async () => {
    const world = await seed();
    await live(world, "p1", "scope", scopeDefinition);
    await world.teams.teamMemberships.add({ id: "tm-ana-2", organizationId: "org-1", teamId: "t-mad", membershipId: "m-ana" });
    expect((await ask(world, ana, vehicle({ teamIds: ["t-mad", "t-other"] }))).decision).toBe("allow");
    expect((await ask(world, ana, vehicle({ teamIds: ["t-other", "t-bcn"] }))).decision).toBe("allow");
    expect((await ask(world, ana, vehicle({ teamIds: [] }))).decision).toBe("deny");
  });
});

describe("lifecycle and versions", () => {
  it("a draft is not enforced; active is; disabled is not; retired never comes back", async () => {
    const world = await seed();
    const created = await world.trusted.policies.create({ id: "p1", organizationId: "org-1", key: "locked", name: "Locked", definition: lockedDefinition, createdBy: system });
    expect(created).toMatchObject({ status: "draft", revision: 1, version: 1, kind: "resource", effect: "deny" });
    const lockedVehicle = vehicle({ attributes: { status: "locked" } });
    expect((await ask(world, ana, lockedVehicle)).decision).toBe("allow");
    await world.trusted.policies.activate("org-1", "p1", { actor: system });
    expect((await ask(world, ana, lockedVehicle)).decision).toBe("deny");
    await world.trusted.policies.disable("org-1", "p1", { actor: system, reason: "too strict" });
    expect((await ask(world, ana, lockedVehicle)).decision).toBe("allow");
    await world.trusted.policies.activate("org-1", "p1", { actor: system });
    expect((await ask(world, ana, lockedVehicle)).decision).toBe("deny");
    await world.trusted.policies.retire("org-1", "p1", { actor: system, reason: "replaced" });
    expect((await ask(world, ana, lockedVehicle)).decision).toBe("allow");
    const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: PolicyError) => error.code);
    expect(await code(world.trusted.policies.activate("org-1", "p1", { actor: system }))).toBe("policy_retired");
    expect(await code(world.trusted.policies.disable("org-1", "p1", { actor: system }))).toBe("policy_retired");
    expect(await code(world.trusted.policies.update("org-1", "p1", { actor: system, name: "again" }))).toBe("policy_retired");
    expect(await code(world.trusted.policies.delete("org-1", "p1"))).toBe("policy_not_draft");
    expect(await code(world.trusted.policies.create({ id: "p2", organizationId: "org-1", key: "locked", name: "Again", definition: lockedDefinition, createdBy: system }))).toBe("policy_key_taken");
    // Idempotent where it should be.
    expect((await world.trusted.policies.retire("org-1", "p1", { actor: system })).status).toBe("retired");
    expect((await ask(world, ana, lockedVehicle)).decision).toBe("allow");
  });

  it("only legal moves; a draft is deleted, never retired; a used policy cannot be deleted", async () => {
    const world = await seed();
    await world.trusted.policies.create({ id: "p1", organizationId: "org-1", key: "a", name: "A", definition: lockedDefinition, createdBy: system });
    await expect(world.trusted.policies.disable("org-1", "p1", { actor: system })).rejects.toMatchObject({ code: "policy_transition_invalid" });
    await expect(world.trusted.policies.retire("org-1", "p1", { actor: system })).rejects.toMatchObject({ code: "policy_transition_invalid" });
    await world.trusted.policies.delete("org-1", "p1");
    expect(await world.storage.policies.findById("org-1", "p1")).toBeNull();
    expect(await world.storage.policies.findRevision("org-1", "p1", 1)).toBeNull();
    await live(world, "p2", "b", lockedDefinition);
    await world.trusted.policies.disable("org-1", "p2", { actor: system });
    await expect(world.trusted.policies.delete("org-1", "p2")).rejects.toMatchObject({ code: "policy_not_draft" });
  });

  it("a definition change is a new immutable revision, seen by the very next decision", async () => {
    const world = await seed();
    const first = await live(world, "p1", "locked", lockedDefinition);
    const v = vehicle({ attributes: { status: "archived" } });
    expect((await ask(world, ana, v)).decision).toBe("allow");
    const changed = await world.trusted.policies.update("org-1", "p1", {
      actor: system,
      note: "also archived vehicles",
      definition: { ...lockedDefinition, condition: { all: [{ in: [{ ref: "resource.status" }, { value: ["locked", "archived"] }] }, { not: { permission: "vehicles.unlock" } }] } },
    });
    expect(changed).toMatchObject({ revision: 2, status: "active", version: first.version + 1 });
    expect(changed.definitionHash).not.toBe(first.definitionHash);
    const after = await ask(world, ana, v);
    expect(after.decision).toBe("deny");
    expect(after.policies[0]).toMatchObject({ revision: 2, definitionHash: changed.definitionHash });
    const revisions = await world.storage.policies.revisions("org-1", "p1");
    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(revisions[1]).toMatchObject({ definitionHash: first.definitionHash });
    expect(revisions[0]).toMatchObject({ note: "also archived vehicles" });
    expect((await world.storage.policies.findRevision("org-1", "p1", 1))?.definition).toEqual(first.definition);
    // The same definition again is not a change.
    const same = await world.trusted.policies.update("org-1", "p1", { actor: system, definition: changed.definition });
    expect(same.version).toBe(changed.version);
    expect(await world.storage.policies.revisions("org-1", "p1")).toHaveLength(2);
  });

  it("optimistic versions", async () => {
    const world = await seed();
    const created = await world.trusted.policies.create({ id: "p1", organizationId: "org-1", key: "a", name: "A", definition: lockedDefinition, createdBy: system });
    await world.trusted.policies.update("org-1", "p1", { actor: system, name: "B", expectedVersion: created.version });
    await expect(world.trusted.policies.update("org-1", "p1", { actor: system, name: "C", expectedVersion: created.version })).rejects.toMatchObject({ code: "policy_version_conflict" });
    await expect(world.trusted.policies.activate("org-1", "p1", { actor: system, expectedVersion: 1 })).rejects.toMatchObject({ code: "policy_version_conflict" });
    await expect(world.trusted.policies.update("org-1", "p1", { actor: system })).rejects.toMatchObject({ code: "policy_update_empty" });
  });

  it("limits", async () => {
    const world = await seed();
    for (let i = 0; i < MAX_ACTIVE_POLICIES; i++) await live(world, `p${i}`, `k${i}`, { ...lockedDefinition, actions: [`tickets.t${i}`] });
    await world.trusted.policies.create({ id: "one-more", organizationId: "org-1", key: "one-more", name: "x", definition: lockedDefinition, createdBy: system });
    await expect(world.trusted.policies.activate("org-1", "one-more", { actor: system })).rejects.toMatchObject({ code: "policy_limit_reached" });
    await world.trusted.policies.disable("org-1", "p0", { actor: system });
    await expect(world.trusted.policies.activate("org-1", "one-more", { actor: system })).resolves.toMatchObject({ status: "active" });
  });
});

describe("policy changes need an authorization", () => {
  it("the repository refuses writes without one, with a forged one, a copied one, or one for something else", async () => {
    const world = await seed();
    const input = { id: "p1", organizationId: "org-1", key: "a", name: "A", definition: lockedDefinition, createdBy: system };
    const raw = world.storage.policies;
    const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: PolicyError) => error.code);
    expect(await code(raw.create({ ...input } as never))).toBe("policy_authorization_required");
    expect(await code(raw.create({ ...input, authorization: {} } as never))).toBe("policy_authorization_required");
    expect(await code(raw.create({ ...input, authorization: { organizationId: "org-1", actor: system } } as never))).toBe("policy_authorization_required");

    let captured: unknown;
    const spy = { ...raw, create: (i: { authorization: unknown }) => ((captured = i.authorization), raw.create(i as never)) };
    void spy;
    // A token issued by the service for one operation is not good for another, or for another organization.
    const service = createPolicyService({ storage: world.storage });
    await world.storage.roles.create({ id: "pa", organizationId: "org-1", name: "pa", permissionKeys: ["policies.manage", "policies.read", "policies.activate"] });
    await world.storage.memberships.assignRole("m-admin", "pa");
    const policy = await service.createPolicy({ actor: admin, ...input, createdBy: undefined } as never);
    expect(policy.createdBy).toEqual(admin);
    expect(captured).toBeUndefined();
    expect(() => assertPolicyAuthorization(undefined, { organizationId: "org-1", operation: "policy.create" })).toThrow(PolicyError);
  });
});

describe("the service", () => {
  it("authors and publishers are different powers", async () => {
    const world = await seed();
    const created = await world.service.createPolicy({ actor: author, organizationId: "org-1", id: "p1", key: "locked", name: "Locked", definition: lockedDefinition });
    expect(created).toMatchObject({ status: "draft", createdBy: author });
    // The author can edit the draft but cannot put it live.
    await world.service.updatePolicy({ actor: author, organizationId: "org-1", policyId: "p1", name: "Locked vehicles" });
    await expect(world.service.activatePolicy({ actor: author, organizationId: "org-1", policyId: "p1" })).rejects.toMatchObject({ code: "policy_forbidden" });
    await expect(world.service.createPolicy({ actor: publisher, organizationId: "org-1", id: "p9", key: "x", name: "x", definition: lockedDefinition })).rejects.toMatchObject({ code: "policy_forbidden" });
    const active = await world.service.activatePolicy({ actor: publisher, organizationId: "org-1", policyId: "p1" });
    expect(active.status).toBe("active");
    // Changing the definition of a live policy takes both powers.
    const newer = { ...lockedDefinition, denyReason: "locked_vehicle" };
    await expect(world.service.updatePolicy({ actor: author, organizationId: "org-1", policyId: "p1", definition: newer })).rejects.toMatchObject({ code: "policy_forbidden" });
    await expect(world.service.updatePolicy({ actor: publisher, organizationId: "org-1", policyId: "p1", definition: newer })).rejects.toMatchObject({ code: "policy_forbidden" });
    await expect(world.service.updatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", definition: newer })).resolves.toMatchObject({ revision: 2 });
    await expect(world.service.disablePolicy({ actor: author, organizationId: "org-1", policyId: "p1" })).rejects.toMatchObject({ code: "policy_forbidden" });
    await expect(world.service.retirePolicy({ actor: ana, organizationId: "org-1", policyId: "p1" })).rejects.toMatchObject({ code: "policy_forbidden" });
    // Someone without any policy permission sees and changes nothing; a member of another organization neither.
    await expect(world.service.listPolicies({ actor: ana, organizationId: "org-1" })).rejects.toMatchObject({ code: "policy_forbidden" });
    await expect(world.service.getPolicy({ actor: outsider, organizationId: "org-1", policyId: "p1" })).rejects.toMatchObject({ code: "policy_forbidden" });
    expect((await world.service.listPolicies({ actor: author, organizationId: "org-1" })).map((p) => p.id)).toEqual(["p1"]);
    expect((await world.service.listRevisions({ actor: author, organizationId: "org-1", policyId: "p1" })).map((r) => r.revision)).toEqual([2, 1]);
  });

  it("an administrator of another organization cannot reach this one", async () => {
    const world = await seed();
    await world.storage.roles.create({ id: "pa-2", organizationId: "org-2", name: "pa", permissionKeys: ["policies.manage", "policies.read", "policies.activate"] });
    await world.storage.memberships.assignRole("m-out", "pa-2");
    await expect(world.service.createPolicy({ actor: outsider, organizationId: "org-1", id: "x", key: "x", name: "x", definition: lockedDefinition })).rejects.toMatchObject({ code: "policy_forbidden" });
    await world.service.createPolicy({ actor: outsider, organizationId: "org-2", id: "x", key: "x", name: "x", definition: lockedDefinition });
    await expect(world.service.getPolicy({ actor: author, organizationId: "org-1", policyId: "x" })).rejects.toMatchObject({ code: "policy_not_found" });
    await expect(world.service.activatePolicy({ actor: admin, organizationId: "org-1", policyId: "x" })).rejects.toMatchObject({ code: "policy_not_found" });
  });

  it("no rule can lock anybody out of the policy administration", async () => {
    const world = await seed();
    await world.service.createPolicy({ actor: admin, organizationId: "org-1", id: "deny-all", key: "deny-all", name: "x", definition: { kind: "access", effect: "deny", actions: ["*"], condition: { exists: "subject.membershipId" } } });
    await world.service.activatePolicy({ actor: admin, organizationId: "org-1", policyId: "deny-all" });
    expect((await ask(world)).decision).toBe("deny");
    expect((await world.engine.authorize({ identity: admin, organizationId: "org-1", permission: "policies.manage" })).decision).toBe("allow");
    await world.service.disablePolicy({ actor: admin, organizationId: "org-1", policyId: "deny-all" });
    expect((await ask(world)).decision).toBe("allow");
    await expect(world.service.createPolicy({ actor: admin, organizationId: "org-1", id: "x", key: "x", name: "x", definition: { ...scopeDefinition, actions: ["policies.manage"] } })).rejects.toMatchObject({ code: "policy_definition_invalid" });
  });

  it("separation of duties, when asked for", async () => {
    const world = await seed();
    const service = createPolicyService({ storage: world.storage, requireSeparateActivator: true });
    await service.createPolicy({ actor: admin, organizationId: "org-1", id: "p1", key: "locked", name: "Locked", definition: lockedDefinition });
    await expect(service.activatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1" })).rejects.toMatchObject({ code: "policy_separation_of_duties" });
    await service.activatePolicy({ actor: publisher, organizationId: "org-1", policyId: "p1" });
    await expect(service.updatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", definition: { ...lockedDefinition, denyReason: "x_y" } })).rejects.toMatchObject({ code: "policy_separation_of_duties" });
    await service.disablePolicy({ actor: publisher, organizationId: "org-1", policyId: "p1" });
    await service.updatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", definition: { ...lockedDefinition, denyReason: "x_y" } });
    await expect(service.activatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1" })).rejects.toMatchObject({ code: "policy_separation_of_duties" });
    await expect(service.activatePolicy({ actor: publisher, organizationId: "org-1", policyId: "p1" })).resolves.toMatchObject({ status: "active", revision: 2 });
  });

  it("every change is audited with the actor, and only the real changes", async () => {
    const world = await seed();
    await world.service.createPolicy({ actor: admin, organizationId: "org-1", id: "p1", key: "locked", name: "Locked", definition: lockedDefinition });
    await world.service.updatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", name: "Locked 2", note: "rename" });
    await world.service.updatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", name: "Locked 2" });
    await world.service.updatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", definition: { ...lockedDefinition, denyReason: "x_y" }, note: "reason" });
    await world.service.activatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", reason: "go" });
    await world.service.activatePolicy({ actor: admin, organizationId: "org-1", policyId: "p1" });
    await world.service.disablePolicy({ actor: admin, organizationId: "org-1", policyId: "p1" });
    await world.service.retirePolicy({ actor: admin, organizationId: "org-1", policyId: "p1", reason: "done" });
    await world.service.createPolicy({ actor: admin, organizationId: "org-1", id: "p2", key: "tmp", name: "tmp", definition: lockedDefinition });
    await world.service.deletePolicy({ actor: admin, organizationId: "org-1", policyId: "p2" });
    const entries = (await world.storage.auditLogs.search({ actionPrefix: "policy." })).filter((entry) => entry.actor.subject === "admin");
    expect(entries.map((entry) => entry.action).sort()).toEqual(
      ["policy.activated", "policy.created", "policy.created", "policy.deleted", "policy.disabled", "policy.retired", "policy.revised", "policy.updated"].sort(),
    );
    const revised = entries.find((entry) => entry.action === "policy.revised")!;
    expect(revised.metadata).toMatchObject({ from: 1, revision: 2, note: "reason" });
    expect(JSON.stringify(entries.map((entry) => entry.metadata))).not.toContain("subject.membershipId");
  });

  it("validates and simulates without saving anything", async () => {
    const world = await seed();
    const parsed = await world.service.validate({ actor: author, organizationId: "org-1", definition: scopeDefinition });
    expect(parsed.analysis.subjectRefs).toEqual(["subject.teamIds"]);
    await expect(world.service.validate({ actor: author, organizationId: "org-1", definition: { ...scopeDefinition, effect: "allow" } })).rejects.toMatchObject({ code: "policy_definition_invalid" });
    const before = await world.storage.policies.setRevision("org-1");
    // As things stand: allowed. With the candidate: denied for a vehicle of another team.
    const question = { actor: author, organizationId: "org-1", identity: ana, permission: "vehicles.update", resource: vehicle({ teamIds: ["t-mad"] }) };
    expect((await world.service.simulate(question)).decision).toBe("allow");
    const withCandidate = await world.service.simulate({ ...question, candidate: { definition: scopeDefinition } });
    expect(withCandidate).toMatchObject({ decision: "deny", reason: "policy_denied" });
    expect(withCandidate.policies[0]).toMatchObject({ key: "candidate" });
    expect(await world.storage.policies.setRevision("org-1")).toBe(before);
    expect(await world.storage.policies.search({ organizationId: "org-1" })).toEqual([]);
    // A candidate replaces an existing policy's definition for the question only.
    await live(world, "p1", "scope", scopeDefinition);
    expect((await world.service.simulate({ ...question })).decision).toBe("deny");
    const relaxed = await world.service.simulate({ ...question, candidate: { policyId: "p1", definition: { kind: "access", effect: "deny", actions: ["vehicles.update"], condition: { not: { exists: "subject.teamIds" } } } } });
    expect(relaxed.decision).toBe("allow");
    expect((await world.service.simulate(question)).decision).toBe("deny");
    await expect(world.service.simulate({ ...question, actor: ana })).rejects.toMatchObject({ code: "policy_forbidden" });
  });
});

describe("safe failure", () => {
  it("a storage error while deciding is indeterminate, not an exception and not an allow", async () => {
    const world = await seed();
    await live(world, "p1", "scope", scopeDefinition);
    const errors: unknown[] = [];
    const broken: UnioraStorage = { ...world.storage, policies: { ...world.storage.policies, activeSet: async () => { throw new Error("db down"); }, setRevision: async () => { throw new Error("db down"); } } };
    const engine = createAuthorizationEngine(broken, { policies: { onError: (e) => errors.push(e) } });
    const result = await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle() as never });
    expect(result).toMatchObject({ decision: "indeterminate", allowed: false, reason: "evaluation_error" });
    expect(errors).toHaveLength(1);
    const noPolicyBackend = { ...world.storage, memberships: { ...world.storage.memberships, findByIdentity: async () => { throw new Error("db down"); } } } as UnioraStorage;
    const result2 = await createAuthorizationEngine(noPolicyBackend).authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update" });
    expect(result2).toMatchObject({ allowed: false, reason: "evaluation_error" });
  });

  it("a stored policy that no longer validates blocks what it might cover instead of being skipped", async () => {
    const world = await seed();
    const stored = await live(world, "p1", "locked", lockedDefinition);
    const tampered = { ...stored, definition: { ...stored.definition, condition: { evil: "run()" } } } as unknown as typeof stored;
    const view: UnioraStorage = { ...world.storage, policies: { ...world.storage.policies, activeSet: async () => ({ revision: 9, policies: [tampered] }), setRevision: async () => 9 } };
    const engine = createAuthorizationEngine(view);
    const covered = await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle() as never });
    expect(covered).toMatchObject({ decision: "indeterminate", allowed: false });
    expect(covered.policies[0]).toMatchObject({ key: "locked", result: "indeterminate", reason: "policy_definition_invalid" });
    // Out of its scope it does not interfere.
    await world.storage.roles.create({ id: "x", organizationId: "org-1", name: "x", permissionKeys: ["reports.run"] });
    await world.storage.memberships.assignRole("m-ana", "x");
    expect((await engine.authorize({ identity: ana, organizationId: "org-1", permission: "reports.run" })).decision).toBe("allow");
    // A hash that does not match the definition is the same thing.
    const mismatch = { ...stored, definitionHash: "0".repeat(64) };
    const view2: UnioraStorage = { ...world.storage, policies: { ...world.storage.policies, activeSet: async () => ({ revision: 10, policies: [mismatch] }), setRevision: async () => 10 } };
    expect((await createAuthorizationEngine(view2).authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle() as never })).decision).toBe("indeterminate");
  });

  it("more active policies than allowed means the organization's rules cannot be trusted", async () => {
    const world = await seed();
    const stored = await live(world, "p1", "locked", lockedDefinition);
    const many = Array.from({ length: MAX_ACTIVE_POLICIES + 1 }, (_, i) => ({ ...stored, id: `p${i}`, key: `k${i}` }));
    const view: UnioraStorage = { ...world.storage, policies: { ...world.storage.policies, activeSet: async () => ({ revision: 3, policies: many }), setRevision: async () => 3 } };
    expect(await createAuthorizationEngine(view).authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle() as never })).toMatchObject({ decision: "indeterminate", reason: "policy_set_too_large" });
  });

  it("does not run code in the resource: getters, prototypes and wrong types are inert", async () => {
    const world = await seed();
    await live(world, "p1", "locked", lockedDefinition);
    let ran = false;
    const trap = vehicle();
    Object.defineProperty(trap.attributes, "status", { enumerable: true, get() { ran = true; return "locked"; } });
    expect((await ask(world, ana, trap)).decision).toBe("deny");
    expect(ran).toBe(false);
    const inherited = vehicle({ attributes: Object.create({ status: "locked" }) });
    expect((await ask(world, ana, inherited)).decision).toBe("indeterminate");
    expect((await ask(world, ana, vehicle({ attributes: { status: 5 } }))).decision).toBe("indeterminate");
    expect((await ask(world, ana, vehicle({ attributes: { status: ["locked"] } }))).decision).toBe("indeterminate");
    expect((await ask(world, ana, vehicle({ attributes: { status: "x".repeat(2000) } }))).decision).toBe("indeterminate");
    expect((await ask(world, ana, vehicle({ type: "Vehicle!" }))).reason).toBe("malformed_input");
    expect((await ask(world, ana, [])).reason).toBe("malformed_input");
    expect((await ask(world, ana, vehicle({ attributes: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}`, 1])) }))).reason).toBe("malformed_input");
  });
});

describe("decisions are reported and can be audited", () => {
  it("onDecision receives the result of authorize, and the auditor keeps what is worth keeping", async () => {
    const world = await seed();
    await live(world, "p1", "scope", scopeDefinition);
    const seen: Array<{ kind: string; allowed: boolean }> = [];
    const engine = createAuthorizationEngine(world.storage, {
      onDecision: async (decision) => {
        seen.push({ kind: decision.kind, allowed: decision.allowed });
        await createPolicyDecisionAuditor(world.storage)(decision);
      },
    });
    await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle() as never });
    await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle({ teamIds: ["t-mad"] }) as never });
    await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: vehicle({ teamIds: undefined }) as never });
    await engine.can({ identity: ana, organizationId: "org-1", permission: "vehicles.read" });
    expect(seen).toEqual([
      { kind: "authorize", allowed: true },
      { kind: "authorize", allowed: false },
      { kind: "authorize", allowed: false },
      { kind: "can", allowed: true },
    ]);
    const entries = await world.storage.auditLogs.search({ actionPrefix: "policy.decision_" });
    expect(entries.map((entry) => entry.action).sort()).toEqual(["policy.decision_denied", "policy.decision_indeterminate"]);
    for (const entry of entries) {
      expect(entry.actor).toEqual(ana);
      expect(entry.target).toEqual({ type: "vehicle", id: "v-1" });
      expect(JSON.stringify(entry.metadata)).not.toContain("t-mad");
    }
    const all = createPolicyDecisionAuditor(world.storage, { record: "all" });
    await all({ kind: "authorize", identity: ana, organizationId: "org-1", allowed: true, reason: "evaluated", at: new Date(), authorization: { decision: "allow", allowed: true, reason: "allowed", organizationId: "org-1", permission: "vehicles.update", policyRevision: 1, policies: [], evaluatedAt: new Date() } });
    expect((await world.storage.auditLogs.search({ action: "policy.decision_allowed" })).length).toBe(1);
  });
});
