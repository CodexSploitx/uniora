import { afterEach, describe, expect, it } from "vitest";
import { BACKENDS, startFixture } from "./test-support/harness.js";
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
const rule = { kind: "access", effect: "deny", actions: ["reports.read"], condition: { eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] } };

describe.each(BACKENDS)("policy routes over %s", (backend) => {
  it("runs the whole lifecycle, and an active policy changes what authorize answers", async () => {
    const { f, token, as } = await start(backend);
    const mgr = as("mgr");
    const created = await mgr("POST", `${ORG}/policies`, { body: { key: "needs-team", name: "Needs a team", definition: rule } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: "needs-team", status: "draft", kind: "access", effect: "deny", revision: 1, version: 1 });
    const policyId = created.body.id as string;
    expect(created.headers.get("location")).toBe(`${ORG}/policies/${policyId}`);

    const ask = () => f.call("POST", "/v1/authorize", { token, body: { identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" } });
    expect((await ask()).body).toMatchObject({ allowed: true });
    const active = await mgr("POST", `${ORG}/policies/${policyId}/activate`, { body: { reason: "go" } });
    expect(active.body.status).toBe("active");
    expect((await ask()).body).toMatchObject({ allowed: false, reason: "policy_denied" });

    const revised = await mgr("PATCH", `${ORG}/policies/${policyId}`, { body: { definition: { ...rule, denyReason: "no_team" }, note: "why" } });
    expect(revised.body.revision).toBe(2);
    expect((await mgr("PATCH", `${ORG}/policies/${policyId}`, { body: { name: "X" }, headers: { "if-match": '"1"' } })).status).toBe(412);
    const revisions = await mgr("GET", `${ORG}/policies/${policyId}/revisions?limit=1`);
    expect(revisions.body.items.map((r: { revision: number }) => r.revision)).toEqual([2]);
    expect(revisions.body.nextCursor).toEqual(expect.any(String));
    const older = await mgr("GET", `${ORG}/policies/${policyId}/revisions?limit=1&cursor=${encodeURIComponent(revisions.body.nextCursor)}`);
    expect(older.body.items.map((r: { revision: number }) => r.revision)).toEqual([1]);

    expect((await mgr("POST", `${ORG}/policies/${policyId}/disable`, { body: {} })).body.status).toBe("disabled");
    expect((await ask()).body).toMatchObject({ allowed: true });
    expect((await mgr("POST", `${ORG}/policies/${policyId}/retire`, { body: {} })).body.status).toBe("retired");
    expect((await mgr("POST", `${ORG}/policies/${policyId}/activate`, { body: {} })).status).toBeGreaterThanOrEqual(400);

    const list = await mgr("GET", `${ORG}/policies?status=retired`);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([policyId]);
    expect((await mgr("GET", `${ORG}/policies/${policyId}`)).body.id).toBe(policyId);
    expect((await mgr("GET", `/v1/organizations/org_globex/policies/${policyId}`)).status).toBe(403);

    const draft = await mgr("POST", `${ORG}/policies`, { body: { key: "other", name: "Other", definition: rule } });
    expect((await mgr("DELETE", `${ORG}/policies/${draft.body.id}`)).body).toEqual({ deleted: true });
  });

  it("validates and simulates without saving anything", async () => {
    const { as } = await start(backend);
    const mgr = as("mgr");
    const valid = await mgr("POST", `${ORG}/policy-validations`, { body: { definition: rule } });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ definition: { kind: "access" }, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const invalid = await mgr("POST", `${ORG}/policy-validations`, { body: { definition: { kind: "access" } } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("policy_definition_invalid");

    const simulated = await mgr("POST", `${ORG}/policy-simulations`, { body: { identity: { subject: "ana" }, permission: "reports.read", candidate: { definition: rule } } });
    expect(simulated.status).toBe(200);
    expect(simulated.body).toMatchObject({ allowed: false, decision: "deny", reason: "policy_denied" });
    expect(simulated.body.policies).toHaveLength(1);
    expect((await mgr("GET", `${ORG}/policies`)).body.items).toEqual([]);
  });

  it("refuses an end user without the policy permissions, and never lets the client pick the id", async () => {
    const { as } = await start(backend);
    expect((await as("ana")("GET", `${ORG}/policies`)).body.code).toBe("forbidden");
    expect((await as("ana")("POST", `${ORG}/policies`, { body: { key: "k", name: "n", definition: rule } })).body.code).toBe("forbidden");
    expect((await as("mgr")("POST", `${ORG}/policies`, { body: { id: "chosen", key: "k", name: "n", definition: rule } })).status).toBe(400);
  });

  it("keeps working in read-only mode for validation and simulation, but not for changes", async () => {
    const f = await startFixture(backend, { readOnly: true });
    open.push(f);
    const { token } = await f.issue();
    const call = (method: string, path: string, body?: unknown) => f.call(method, path, { token, actor: "mgr", ...(body !== undefined ? { body } : {}) });
    expect((await call("POST", `${ORG}/policy-validations`, { definition: rule })).status).toBe(200);
    expect((await call("GET", `${ORG}/policies`)).status).toBe(200);
    expect((await call("POST", `${ORG}/policies`, { key: "k", name: "n", definition: rule })).status).toBe(503);
  });
});
