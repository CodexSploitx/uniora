import { describe, expect, it } from "vitest";
import { POLICY_PERMISSIONS, createAuthorizationEngine, createMemoryStorage, createPolicyService, createTrustedPolicyStorage } from "@uniora/core";
import { AuthorizationDeniedError } from "./guard.js";
import { PolicyDeniedError, assertAuthorized, authorizeResourceRoute, policyCommandRoute } from "./policies.js";

const admin = { provider: "p", subject: "admin" };
const juan = { provider: "p", subject: "juan" };

async function setup() {
  const storage = createMemoryStorage();
  const trusted = createTrustedPolicyStorage(storage, { actor: admin, reason: "route test" });
  await storage.organizations.create({ id: "org", name: "Acme" });
  for (const key of [...Object.values(POLICY_PERMISSIONS), "reports.run"]) await storage.permissions.register({ key });
  await storage.roles.create({ id: "admin", organizationId: "org", name: "Admin", permissionKeys: Object.values(POLICY_PERMISSIONS) });
  await storage.roles.create({ id: "staff", organizationId: "org", name: "Staff", permissionKeys: ["reports.run"] });
  await storage.memberships.create({ id: "m-admin", organizationId: "org", identity: admin, roleIds: ["admin"] });
  await storage.memberships.create({ id: "m-juan", organizationId: "org", identity: juan, roleIds: ["staff"] });
  const rule = { kind: "access", effect: "deny", actions: ["reports.run"], condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] } };
  await trusted.policies.create({ id: "p1", organizationId: "org", key: "no-reports", name: "No reports", definition: rule, createdBy: admin });
  return { policies: createPolicyService({ storage }), engine: createAuthorizationEngine(storage), trusted };
}

describe("policyCommandRoute", () => {
  it("answers 401 without a caller", async () => {
    const { policies } = await setup();
    expect((await policyCommandRoute(policies, { command: "listPolicies", caller: null, params: {} })).status).toBe(401);
  });

  it("runs the command as the caller and maps refusals to a generic 403", async () => {
    const { policies } = await setup();
    const ok = await policyCommandRoute(policies, { command: "activatePolicy", caller: { actor: admin, organizationId: "org" }, params: { policyId: "p1" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: "p1", status: "active" });
    const denied = await policyCommandRoute(policies, { command: "listPolicies", caller: { actor: juan, organizationId: "org" }, params: {} });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
  });

  it("rejects fields the client must not set and rethrows what is not a policy error", async () => {
    const { policies } = await setup();
    const bad = await policyCommandRoute(policies, { command: "getPolicy", caller: { actor: admin, organizationId: "org" }, params: { policyId: "p1", authorization: {} } });
    expect(bad.status).toBe(400);
    await expect(
      policyCommandRoute({ ...policies, getPolicy: async () => { throw new Error("db down"); } }, { command: "getPolicy", caller: { actor: admin, organizationId: "org" }, params: { policyId: "p1" } }),
    ).rejects.toThrow("db down");
  });
});

describe("assertAuthorized / authorizeResourceRoute", () => {
  it("allows while the policy is not live, refuses once it is, and never leaks the policies in the response", async () => {
    const { engine, trusted } = await setup();
    const input = { identity: juan, organizationId: "org", permission: "reports.run" };
    expect((await assertAuthorized(engine, input)).allowed).toBe(true);
    expect(await authorizeResourceRoute(engine, input)).toBeNull();
    await trusted.policies.activate("org", "p1", { actor: admin });
    const error = await assertAuthorized(engine, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect(error).toBeInstanceOf(AuthorizationDeniedError);
    expect((error as PolicyDeniedError).result).toMatchObject({ decision: "deny", reason: "policy_denied" });
    const response = await authorizeResourceRoute(engine, input);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "forbidden" });
  });

  it("treats indeterminate as a refusal", async () => {
    const engine = { authorize: async () => ({ decision: "indeterminate", allowed: false, reason: "policy_indeterminate", policies: [] }) } as never;
    await expect(assertAuthorized(engine, { identity: juan, organizationId: "org", permission: "x.y" })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect((await authorizeResourceRoute(engine, { identity: juan, organizationId: "org", permission: "x.y" }))?.status).toBe(403);
  });
});
