import { afterEach, describe, expect, it } from "vitest";
import { createMemoryApiCredentialStorage, createMemoryPlatformStorage, createMemoryStorage } from "@uniora/core";
import { ServerConfigError, createUnioraServer, silentLogger } from "./index.js";
import { BACKENDS, IDP, platformOptions, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";
import { nowSeconds } from "./test-support/jwt.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});
async function start(name: BackendName, extra: Parameters<typeof platformOptions>[1] = {}): Promise<Fixture> {
  const fixture = await startFixture(name, (backend) => platformOptions(backend, extra));
  open.push(fixture);
  return fixture;
}

describe.each(BACKENDS)("platform routes over %s", (backend) => {
  it("lists what the bootstrap created, with a read that needs no second factor", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    // A token with no `auth_time` at all: fine for a read.
    const headers = { "uniora-actor-token": f.sign("root", { provider: "staff" }) };
    const roles = await f.call("GET", "/v1/platform/roles", { token, headers });
    expect(roles.status).toBe(200);
    expect(roles.body.items).toEqual([expect.objectContaining({ key: "platform_admin", isSystem: true, permissions: ["platform.*"] })]);
    const members = await f.call("GET", "/v1/platform/members", { token, headers });
    expect(members.body.items).toEqual([expect.objectContaining({ identity: { provider: "staff", subject: "root" }, status: "active" })]);
    const orgs = await f.call("GET", "/v1/platform/organizations", { token, headers });
    expect(orgs.body.items.map((o: { id: string }) => o.id).sort()).toEqual(["org_acme", "org_globex"]);
    expect(orgs.text).not.toContain("hunter");
  });

  it("refuses a change without a recent second factor, and says how to get one", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    const body = { key: "support", name: "Support", permissions: ["platform.organizations.read"] };
    const cases: [string, Record<string, unknown>][] = [
      ["no auth_time", {}],
      ["no second factor", { auth_time: nowSeconds() - 10, amr: ["pwd"] }],
      ["a stale sign-in", { auth_time: nowSeconds() - 3600, amr: ["pwd", "mfa"] }],
    ];
    for (const [label, claims] of cases) {
      const response = await f.call("POST", "/v1/platform/roles", { token, operator: { subject: "root", claims: { auth_time: undefined, amr: undefined, ...claims } }, body });
      expect(response.status, label).toBe(428);
      expect(response.body.code, label).toBe("platform_step_up_required");
      expect(response.headers.get("www-authenticate"), label).toContain("insufficient_user_authentication");
    }
    expect((await f.call("GET", "/v1/platform/roles", { token, operator: { subject: "root", claims: { amr: undefined } } })).status).toBe(200);
    const created = await f.call("POST", "/v1/platform/roles", { token, operator: "root", body });
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    expect(created.body).toMatchObject({ key: "support", permissions: ["platform.organizations.read"], isSystem: false, version: 1 });
  });

  it("applies the platform's own rules: no escalation, no self-service, one administrator at least", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    const role = await f.call("POST", "/v1/platform/roles", { token, operator: "root", body: { key: "support", name: "Support", permissions: ["platform.organizations.read", "platform.roles.manage", "platform.members.manage"] } });
    expect(role.status).toBe(201);
    const member = await f.call("POST", "/v1/platform/members", { token, operator: "root", body: { subject: "sam", roleIds: [role.body.id] } });
    expect(member.status).toBe(201);
    expect(member.body.identity).toEqual({ provider: "staff", subject: "sam" });

    // sam holds roles.manage, but cannot hand out what sam does not hold, nor change themselves.
    const escalate = await f.call("POST", "/v1/platform/roles", { token, operator: "sam", body: { key: "greedy", name: "Greedy", permissions: ["platform.support.grant"] } });
    expect(escalate).toMatchObject({ status: 403, body: { code: "forbidden" } });
    const self = await f.call("POST", `/v1/platform/members/${member.body.id}/suspend`, { token, operator: "sam", body: {} });
    expect(self).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(escalate.text).not.toMatch(/escalation|hold/i);
    const unknownMember = await f.call("POST", "/v1/platform/members/pmem_nope/suspend", { token, operator: "root", body: {} });
    expect(unknownMember.status).toBe(404);

    // An outsider is not a member of the platform at all.
    const stranger = await f.call("GET", "/v1/platform/roles", { token, operator: "mallory" });
    expect(stranger).toMatchObject({ status: 403, body: { code: "forbidden" } });

    // The last active administrator stays.
    const rootMember = (await f.call("GET", "/v1/platform/members?status=active", { token, operator: "root" })).body.items.find((m: { identity: { subject: string } }) => m.identity.subject === "root");
    const admin = (await f.call("GET", "/v1/platform/roles", { token, operator: "root" })).body.items.find((r: { key: string }) => r.key === "platform_admin");
    await f.call("PUT", `/v1/platform/members/${member.body.id}/roles/${admin.id}`, { token, operator: "root" });
    const lonely = await f.call("DELETE", `/v1/platform/members/${member.body.id}/roles/${admin.id}`, { token, operator: "root" });
    expect(lonely.status).toBe(200); // root is still there
    const removeRoot = await f.call("DELETE", `/v1/platform/members/${rootMember.id}`, { token, operator: "sam" });
    expect(removeRoot.status).toBe(403);
  });

  it("refuses a stale edit with 412 and keeps an ETag on what it returns", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    const created = await f.call("POST", "/v1/platform/roles", { token, operator: "root", body: { key: "billing", name: "Billing", permissions: ["platform.organizations.read"] } });
    const edited = await f.call("PATCH", `/v1/platform/roles/${created.body.id}`, { token, operator: "root", headers: { "if-match": '"1"' }, body: { name: "Billing ops" } });
    expect(edited).toMatchObject({ status: 200, body: { name: "Billing ops", version: 2 } });
    expect(edited.headers.get("etag")).toBe('"2"');
    const stale = await f.call("PATCH", `/v1/platform/roles/${created.body.id}`, { token, operator: "root", headers: { "if-match": '"1"' }, body: { name: "Again" } });
    expect(stale).toMatchObject({ status: 412, body: { code: "platform_version_conflict" } });
    const gone = await f.call("DELETE", `/v1/platform/roles/${created.body.id}`, { token, operator: "root" });
    expect(gone).toMatchObject({ status: 200, body: { deleted: true } });
    expect((await f.call("DELETE", `/v1/platform/roles/${created.body.id}`, { token, operator: "root" })).status).toBe(404);
  });

  it("only accepts members of a platform provider", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    const roles = (await f.call("GET", "/v1/platform/roles", { token, operator: "root" })).body.items;
    const response = await f.call("POST", "/v1/platform/members", { token, operator: "root", body: { provider: "main", subject: "ana", roleIds: [roles[0].id] } });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([{ path: "provider", code: "enum" }]);
  });

  it("suspends an organization, which then denies every decision, and records it in both trails", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    const ask = { identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" };
    expect((await f.call("POST", "/v1/check", { token, body: ask })).body.allowed).toBe(true);
    const suspended = await f.call("PUT", "/v1/platform/organizations/org_acme/status", { token, operator: "root", body: { status: "suspended", reason: "unpaid" } });
    expect(suspended).toMatchObject({ status: 200, body: { id: "org_acme", status: "suspended" } });
    expect((await f.call("POST", "/v1/check", { token, body: ask })).body.allowed).toBe(false);
    const entries = await f.backend.storage.auditLogs.listRecent({ limit: 20 });
    const entry = entries.find((e) => e.organizationId === "org_acme" && e.action.includes("status"));
    expect(entry?.metadata?.via).toMatchObject({ apiClientId: expect.stringMatching(/^apc_/), actorMode: "verified", requestId: suspended.headers.get("request-id") });
    expect(entry?.actor).toEqual({ provider: "staff", subject: "root" });
    expect((await f.call("PUT", "/v1/platform/organizations/org_nope/status", { token, operator: "root", body: { status: "active" } })).status).toBe(404);
  });

  it("opens narrow support access for the operator and ends it", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const grant = await f.call("POST", "/v1/platform/support-grants", { token, operator: "root", body: { organizationId: "org_acme", permissions: ["reports.read"], reason: "ticket 42", expiresAt } });
    expect(grant.status).toBe(201);
    expect(grant.body).toMatchObject({ organizationId: "org_acme", operator: { provider: "staff", subject: "root" }, permissions: ["reports.read"], reason: "ticket 42" });
    const wide = await f.call("POST", "/v1/platform/support-grants", { token, operator: "root", body: { organizationId: "org_acme", permissions: ["vehicles.delete"], reason: "x", expiresAt } });
    expect(wide.status).toBe(403); // not on supportGrantablePermissions
    const past = await f.call("POST", "/v1/platform/support-grants", { token, operator: "root", body: { organizationId: "org_acme", permissions: ["reports.read"], reason: "x", expiresAt: new Date(Date.now() - 1000).toISOString() } });
    expect(past.status).toBe(400);
    const revoked = await f.call("POST", `/v1/platform/support-grants/${grant.body.id}/revoke`, { token, operator: "root", body: undefined });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).toEqual(expect.any(String));
    expect((await f.call("POST", "/v1/platform/support-grants/sgr_nope/revoke", { token, operator: "root" })).status).toBe(404);
  });

  it("stamps the platform audit trail with the API client that relayed the call", async () => {
    const f = await start(backend);
    const { token, clientId } = await f.issue();
    const response = await f.call("POST", "/v1/platform/roles", { token, operator: "root", body: { key: "support", name: "Support", permissions: [] } });
    expect(response.status).toBe(201);
    const entries = await f.backend.platform.auditLogs.listRecent({ limit: 20 });
    const entry = entries.find((e) => e.action.includes("role"));
    expect(entry?.actor).toEqual({ provider: "staff", subject: "root" });
    expect(entry?.metadata?.via).toMatchObject({ apiClientId: clientId, actorMode: "verified", requestId: response.headers.get("request-id") });
  });

  it("is refused in read-only mode, but reads keep working", async () => {
    const f = await start(backend, { readOnly: true });
    const { token } = await f.issue();
    expect((await f.call("GET", "/v1/platform/roles", { token, operator: "root" })).status).toBe(200);
    expect((await f.call("POST", "/v1/platform/roles", { token, operator: "root", body: { key: "x_role", name: "X", permissions: [] } })).status).toBe(503);
  });

  it("can demand an assurance level on top of the second factor", async () => {
    const f = await start(backend, {});
    open.pop(); // replaced below by a stricter fixture
    await f.stop();
    const strict = await startFixture(backend, async (b) => {
      const options = await platformOptions(b);
      return { ...options, platform: { ...options.platform!, stepUp: { minAssuranceLevel: 2, maxAgeSeconds: 120 } } };
    });
    open.push(strict);
    const { token } = await strict.issue();
    const body = { key: "support", name: "Support", permissions: [] };
    const weak = await strict.call("POST", "/v1/platform/roles", { token, operator: "root", body });
    expect(weak.status).toBe(428);
    const strong = await strict.call("POST", "/v1/platform/roles", { token, operator: { subject: "root", claims: { acr: "urn:mfa" } }, body });
    expect(strong.status).toBe(201);
  });

  it("pages through every organization, whatever the page size", async () => {
    const f = await start(backend);
    const { token } = await f.issue();
    for (const name of ["Initech", "Umbrella", "Hooli"]) await f.call("POST", "/v1/organizations", { token, body: { name, owner: { subject: `owner-${name}` } } });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await f.call("GET", `/v1/platform/organizations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token, operator: "root" });
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((item: { id: string }) => item.id));
      cursor = page.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("makes a change of status work with minAssuranceLevel 0 configured as no minimum", async () => {
    const f = await startFixture(backend, async (b) => {
      const options = await platformOptions(b);
      return { ...options, platform: { ...options.platform!, stepUp: { minAssuranceLevel: 0 } } };
    });
    open.push(f);
    const { token } = await f.issue();
    expect((await f.call("POST", "/v1/platform/roles", { token, operator: "root", body: { key: "support", name: "Support", permissions: [] } })).status).toBe(201);
  });
});

describe("platform configuration", () => {
  const base = () => ({ storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), logger: silentLogger });
  const tokens = [{ provider: "staff", issuer: IDP.staff.issuer, audience: "uniora", algorithms: ["RS256"] as const, jwks: { keys: [IDP.staff.key.publicJwk as never] } }];
  const storage = () => createMemoryPlatformStorage();

  it("needs providers that exist, a sane step-up and no unknown option", () => {
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: [], supportGrantablePermissions: [] } })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["nope"], supportGrantablePermissions: [] } })).toThrow(/platform.providers/);
    expect(() => createUnioraServer({ ...base(), platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [] } })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [], stepUp: { maxAgeSeconds: 0 } } })).toThrow(/maxAgeSeconds/);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [], stepUp: { maxAgeSeconds: 7200 } } })).toThrow(/maxAgeSeconds/);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [], stepUp: { minAssuranceLevel: 2 } } })).toThrow(/acrLevels/);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [], stepUp: { nope: 1 } as never } })).toThrow(/unknown option/);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: undefined as never, providers: ["staff"], supportGrantablePermissions: [] } })).toThrow(/platform.storage/);
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [] } })).not.toThrow();
    // No "any permission" default for support access: the list is required (an empty one means none).
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"] } as never })).toThrow(/supportGrantablePermissions/);
    // `minAssuranceLevel: 0` means no minimum, it does not make every change impossible.
    expect(() => createUnioraServer({ ...base(), actorTokens: tokens, platform: { storage: storage(), providers: ["staff"], supportGrantablePermissions: [], stepUp: { minAssuranceLevel: 0 } } })).not.toThrow();
  });
});
