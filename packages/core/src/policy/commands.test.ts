import { describe, expect, it } from "vitest";
import { POLICY_PERMISSIONS, PolicyError, createMemoryStorage, createPolicyService, createTrustedPolicyStorage, policyErrorToHttp, runPolicyCommand } from "../index.js";

const boss = { provider: "p", subject: "boss" };
const admin = { provider: "p", subject: "admin" };
const juan = { provider: "p", subject: "juan" };

const rule = { kind: "access", effect: "deny", actions: ["reports.run"], condition: { not: { exists: "subject.teamIds" } } };

async function setup() {
  const raw = createMemoryStorage();
  const storage = createTrustedPolicyStorage(raw, { actor: boss, reason: "unit test fixtures" });
  await storage.organizations.create({ id: "org", name: "Acme" });
  await storage.permissions.register({ key: "reports.run" });
  for (const key of Object.values(POLICY_PERMISSIONS)) await storage.permissions.register({ key });
  await storage.roles.create({ id: "admin", organizationId: "org", name: "Admin", permissionKeys: Object.values(POLICY_PERMISSIONS) });
  await storage.roles.create({ id: "staff", organizationId: "org", name: "Staff", permissionKeys: ["reports.run"] });
  await storage.memberships.create({ id: "m-admin", organizationId: "org", identity: admin, roleIds: ["admin"] });
  await storage.memberships.create({ id: "m-juan", organizationId: "org", identity: juan, roleIds: ["staff"] });
  return { service: createPolicyService({ storage: raw }), raw };
}

const run = (service: ReturnType<typeof createPolicyService>, command: string, actor: typeof admin, params: unknown) =>
  runPolicyCommand(service, command, { actor, organizationId: "org" }, params);
const outcome = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof PolicyError ? error.code : String(error)));

describe("runPolicyCommand", () => {
  it("runs the whole lifecycle as the caller, with JSON-safe results and generated ids", async () => {
    const { service } = await setup();
    const created = (await run(service, "createPolicy", admin, { key: "needs-team", name: "Needs a team", definition: rule })) as { id: string; createdAt: string; status: string };
    expect(created.status).toBe("draft");
    expect(typeof created.id).toBe("string");
    expect(typeof created.createdAt).toBe("string");
    const active = (await run(service, "activatePolicy", admin, { policyId: created.id, reason: "go" })) as { status: string };
    expect(active.status).toBe("active");
    const list = (await run(service, "listPolicies", admin, { status: "active", limit: 10 })) as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([created.id]);
    const revised = (await run(service, "updatePolicy", admin, { policyId: created.id, definition: { ...rule, denyReason: "no_team" }, note: "why" })) as { revision: number };
    expect(revised.revision).toBe(2);
    const revisions = (await run(service, "listRevisions", admin, { policyId: created.id })) as { revision: number }[];
    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(await run(service, "disablePolicy", admin, { policyId: created.id })).toMatchObject({ status: "disabled" });
    expect(await run(service, "retirePolicy", admin, { policyId: created.id })).toMatchObject({ status: "retired" });
    expect(await outcome(run(service, "createPolicy", admin, { id: "chosen", key: "other", name: "Other", definition: rule }))).toBe("policy_invalid");
    const draft = (await run(service, "createPolicy", admin, { key: "other", name: "Other", definition: rule })) as { id: string };
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await run(service, "deletePolicy", admin, { policyId: draft.id })).toEqual({ deleted: true });
  });

  it("validates without saving and simulates a decision, including a candidate definition", async () => {
    const { service } = await setup();
    expect(await run(service, "validatePolicy", admin, { definition: rule })).toMatchObject({ definition: { kind: "access" } });
    expect(await outcome(run(service, "validatePolicy", admin, { definition: { kind: "access" } }))).toBe("policy_definition_invalid");
    const result = (await run(service, "simulate", admin, { identity: juan, permission: "reports.run", candidate: { definition: { ...rule, condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] } } } })) as { decision: string; reason: string; policies: unknown[] };
    expect(result).toMatchObject({ decision: "deny", reason: "policy_denied" });
    expect(result.policies).toHaveLength(1);
    expect(await run(service, "listPolicies", admin, {})).toEqual([]);
  });

  it("the service still decides: a caller without the right is refused", async () => {
    const { service } = await setup();
    expect(await outcome(run(service, "createPolicy", juan, { key: "x", name: "X", definition: rule }))).toBe("policy_forbidden");
    expect(await outcome(run(service, "listPolicies", juan, {}))).toBe("policy_forbidden");
    expect(await outcome(run(service, "simulate", juan, { identity: juan, permission: "reports.run" }))).toBe("policy_forbidden");
  });

  it("rejects unknown commands and any field the command does not declare (no actor, authorization or organization from the body)", async () => {
    const { service } = await setup();
    const body = { key: "x", name: "X", definition: rule };
    expect(await outcome(run(service, "dropEverything", admin, {}))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, { ...body, actor: boss }))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, { ...body, organizationId: "other" }))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, { ...body, authorization: {} }))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, { ...body, status: "active" }))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, { ...body, name: 5 }))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, { ...body, definition: "code" }))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, null))).toBe("policy_invalid");
    expect(await outcome(run(service, "createPolicy", admin, []))).toBe("policy_invalid");
    expect(await outcome(run(service, "updatePolicy", admin, { policyId: "p", expectedVersion: -1 }))).toBe("policy_invalid");
    expect(await outcome(run(service, "listPolicies", admin, { limit: 100000 }))).toBe("policy_invalid");
    expect(await outcome(run(service, "simulate", admin, { identity: { provider: "p", subject: "s", extra: 1 }, permission: "x.y" }))).toBe("policy_invalid");
    expect(await outcome(run(service, "simulate", admin, { identity: juan }))).toBe("policy_invalid");
    expect(await run(service, "listPolicies", admin, {})).toEqual([]);
  });
});

describe("policyErrorToHttp", () => {
  it("maps refusals, missing rows, conflicts and bad input; ignores everything else", () => {
    const http = (code: ConstructorParameters<typeof PolicyError>[1]) => policyErrorToHttp(new PolicyError("m", code));
    expect(http("policy_forbidden")).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(http("policy_separation_of_duties")).toMatchObject({ status: 403, body: { error: "policy_separation_of_duties" } });
    expect(http("policy_not_found")?.status).toBe(404);
    expect(http("policy_key_taken")?.status).toBe(409);
    expect(http("policy_version_conflict")?.status).toBe(409);
    expect(http("policy_retired")?.status).toBe(409);
    expect(http("policy_definition_invalid")?.status).toBe(400);
    expect(http("policy_key_invalid")?.status).toBe(400);
    expect(http("policy_authorization_required")).toMatchObject({ status: 500, body: { message: "Something went wrong." } });
    expect(policyErrorToHttp(new Error("boom"))).toBeNull();
  });
});
