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
  const issued = await f.issue();
  const call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; token?: string } = {}) => f.call(method, path, { token: issued.token, ...init });
  return { f, ...issued, call };
}
const signup = (name = "Acme Motors", subject = "founder-1") => ({ name, owner: { subject } });

describe.each(BACKENDS)("organization provisioning over %s", (backend) => {
  it("creates the organization, its Owner role and the founder together, and audits the API client as the actor", async () => {
    const { f, clientId, call } = await start(backend);
    const created = await call("POST", "/v1/organizations", { body: signup() });
    expect(created.status).toBe(201);
    expect(created.body.organization).toMatchObject({ name: "Acme Motors", slug: "acme-motors", status: "active" });
    expect(created.body.ownerRole).toMatchObject({ isOwnerRole: true });
    expect(created.body.membership).toMatchObject({ identity: { provider: "main", subject: "founder-1" }, roleIds: [created.body.ownerRole.id] });
    expect(created.body.replayed).toBeUndefined();

    // The founder can do anything in it, and nobody else can.
    const orgId = created.body.organization.id as string;
    const ask = (subject: string) => call("POST", "/v1/check", { body: { identity: { subject }, organizationId: orgId, permission: "anything.at.all" } });
    expect((await ask("founder-1")).body.allowed).toBe(true);
    expect((await ask("someone-else")).body.allowed).toBe(false);

    const entries = await f.backend.storage.auditLogs.search({ organizationId: orgId, action: "organization.created" });
    expect(entries[0]).toMatchObject({ actor: { provider: "uniora-api", subject: clientId } });
    expect(entries[0]!.metadata?.via).toMatchObject({ apiClientId: clientId, requestId: created.headers.get("request-id") });
    expect((await f.backend.storage.auditLogs.verifyIntegrity()).ok).toBe(true);
  });

  it("without a key, two identical requests are two organizations; the slug is still unique", async () => {
    const { call } = await start(backend);
    const a = await call("POST", "/v1/organizations", { body: { ...signup("Same"), slug: "same-one" } });
    const b = await call("POST", "/v1/organizations", { body: { ...signup("Same"), slug: "same-two" } });
    expect(a.body.organization.id).not.toBe(b.body.organization.id);
    const clash = await call("POST", "/v1/organizations", { body: { ...signup("Other"), slug: "same-one" } });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("organization_slug_taken");
  });

  it("makes a retry safe with an Idempotency-Key, and refuses the key for a different request", async () => {
    const { call } = await start(backend);
    const headers = { "idempotency-key": "signup:42" };
    const first = await call("POST", "/v1/organizations", { body: signup(), headers });
    const second = await call("POST", "/v1/organizations", { body: signup(), headers });
    expect(second.status).toBe(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.organization.id).toBe(first.body.organization.id);
    expect(second.body.membership.id).toBe(first.body.membership.id);

    for (const body of [signup("Another name"), signup("Acme Motors", "someone-else")]) {
      const reused = await call("POST", "/v1/organizations", { body, headers });
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("idempotency_key_reused");
    }
    const list = await call("GET", "/v1/organizations");
    expect(list.body.items.filter((o: { name: string }) => o.name === "Acme Motors")).toHaveLength(1);
  });

  it("creates exactly one organization when the same request arrives many times at once", async () => {
    const { call } = await start(backend);
    const headers = { "idempotency-key": "burst-1" };
    const responses = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/v1/organizations", { body: signup("Burst Inc", "founder-b"), headers })));
    const ids = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.organization.id));
    expect(ids.size).toBe(1);
    for (const response of responses) expect([201, 409]).toContain(response.status);
    expect(responses.filter((r) => r.status === 409).every((r) => r.body.code === "idempotency_in_progress")).toBe(true);
    const list = await call("GET", "/v1/organizations");
    expect(list.body.items.filter((o: { name: string }) => o.name === "Burst Inc")).toHaveLength(1);
  });

  it("keys are per client: another client's same key makes its own organization", async () => {
    const { f, call } = await start(backend);
    const other = await f.issue();
    const headers = { "idempotency-key": "shared-key" };
    const a = await call("POST", "/v1/organizations", { body: signup("A Corp"), headers });
    const b = await call("POST", "/v1/organizations", { body: signup("B Corp"), headers, token: other.token });
    expect(b.status).toBe(201);
    expect(b.body.organization.id).not.toBe(a.body.organization.id);
  });

  it("is only for a client that may reach every organization, and refuses reserved owners", async () => {
    const { f, call } = await start(backend);
    const limited = await f.issue({ organizations: ["org_acme"] });
    expect((await call("POST", "/v1/organizations", { body: signup(), token: limited.token })).status).toBe(403);
    expect((await call("POST", "/v1/organizations", { body: { name: "X", owner: { provider: "uniora-api", subject: "z" } } })).body.code).toBe("identity_provider_reserved");
    const noCreate = await f.issue({ scopes: ["check", "organizations:read"] });
    expect((await call("POST", "/v1/organizations", { body: signup(), token: noCreate.token })).status).toBe(403);
  });
});
