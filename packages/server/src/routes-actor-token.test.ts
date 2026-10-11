import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKENDS, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";
import { nowSeconds, signJwt, testKey } from "./test-support/jwt.js";

const ISSUER = "https://idp.example.com/";
const rsa = testKey("rsa");
const open: Fixture[] = [];
const servers: Server[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
  while (servers.length > 0) await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
});

const token = (subject: string, extra: Record<string, unknown> = {}, key = rsa) =>
  signJwt({ iss: ISSUER, aud: "uniora", sub: subject, iat: nowSeconds() - 5, exp: nowSeconds() + 300, ...extra }, key.privateKey, { alg: "RS256", kid: "rsa-1" });

async function start(name: BackendName, options: Parameters<typeof startFixture>[1] = {}) {
  const f = await startFixture(name, { actorTokens: [{ provider: "main", issuer: ISSUER, audience: "uniora", algorithms: ["RS256"], jwks: { keys: [rsa.publicJwk as never] }, acrLevels: { "urn:strong": 3 } }], ...options });
  open.push(f);
  const verified = (await f.issue({ scopes: ["check", "members:write", "policies:write", "organizations:read", "actor:verified"] })).token;
  const asserting = (await f.issue({ scopes: ["members:write", "actor:assert"] })).token;
  const plain = (await f.issue({ scopes: ["members:write"] })).token;
  return { f, verified, asserting, plain };
}
const ORG = "/v1/organizations/org_acme";
const assign = `${ORG}/members/mem_bob/roles/role_viewer`;

describe.each(BACKENDS)("verified end-user tokens over %s", (backend) => {
  it("changes things as the user in the token, and the audit entry says it was verified", async () => {
    const { f, verified } = await start(backend);
    const response = await f.call("PUT", assign, { token: verified, headers: { "uniora-actor-token": token("mgr") } });
    expect(response.status).toBe(200);
    expect(response.body.roleIds).toEqual(["role_viewer"]);
    const entries = await f.backend.storage.auditLogs.search({ organizationId: "org_acme", action: "membership.role_assigned" });
    expect(entries[0]).toMatchObject({ actor: { provider: "main", subject: "mgr" } });
    expect(entries[0]!.metadata?.via).toMatchObject({ actorMode: "verified", requestId: response.headers.get("request-id") });
  });

  it("applies the rules of the user in the token: a user without the permission is refused", async () => {
    const { f, verified } = await start(backend);
    const response = await f.call("PUT", assign, { token: verified, headers: { "uniora-actor-token": token("ana") } });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("forbidden");
  });

  it("a client with only actor:verified cannot assert a user, and one without any actor scope cannot even present a token", async () => {
    const { f, verified, plain } = await start(backend);
    expect((await f.call("PUT", assign, { token: verified, actor: "mgr" })).status).toBe(403);
    const refused = await f.call("PUT", assign, { token: plain, headers: { "uniora-actor-token": token("mgr") } });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("forbidden");
  });

  it("a client with actor:assert may use either way", async () => {
    const { f, asserting } = await start(backend);
    expect((await f.call("PUT", assign, { token: asserting, headers: { "uniora-actor-token": token("mgr") } })).status).toBe(200);
    expect((await f.call("DELETE", assign, { token: asserting, actor: "mgr" })).status).toBe(200);
  });

  it("answers every bad token the same way, and never says why", async () => {
    const { f, verified } = await start(backend);
    const other = testKey("rsa", "rsa-1");
    const bad = [
      token("mgr", { exp: nowSeconds() - 600 }),
      token("mgr", { aud: "someone-else" }),
      token("mgr", { iss: "https://evil.example.com/" }),
      token("mgr", {}, other),
      `${token("mgr").slice(0, -6)}AAAAAA`,
      "not-a-token",
      signJwt({ iss: ISSUER, aud: "uniora", sub: "mgr", exp: nowSeconds() + 300 }, undefined, { alg: "none" }),
    ];
    const seen = new Set<string>();
    for (const value of bad) {
      const response = await f.call("PUT", assign, { token: verified, headers: { "uniora-actor-token": value } });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("invalid_token");
      seen.add(JSON.stringify({ ...response.body, requestId: "x" }));
      expect(response.text).not.toContain("expired");
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain("actor_token_invalid");
    // The reason is in the operator's log, and the token never is.
    const logged = JSON.stringify(f.logs);
    expect(logged).toContain("actor token refused");
    expect(logged).toContain("bad_signature");
    for (const value of bad) { const signature = value.split(".")[2]; if (signature) expect(logged).not.toContain(signature); }
  });

  it("refuses a token together with an asserted actor, a repeated token, and a token where none is taken", async () => {
    const { f, verified } = await start(backend);
    const both = await f.call("PUT", assign, { token: verified, actor: "mgr", headers: { "uniora-actor-token": token("mgr") } });
    expect(both.status).toBe(400);
    expect(both.body.errors).toEqual([{ path: "Uniora-Actor-Token", code: "too_many" }]);
    const list = await f.call("GET", "/v1/organizations", { token: verified, headers: { "uniora-actor-token": token("mgr") } });
    expect(list.status).toBe(400);
    expect(list.body.errors).toEqual([{ path: "Uniora-Actor-Token", code: "unknown_field" }]);
    // An asserted actor on a route that takes no actor is also refused, not silently ignored.
    const check = await f.call("POST", "/v1/check", { token: verified, actor: "mgr", body: { identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" } });
    expect(check.status).toBe(400);
  });

  it("requireVerifiedActors turns asserted actors off, even for a key that holds actor:assert", async () => {
    const { f, verified, asserting } = await start(backend, { requireVerifiedActors: true });
    const asserted = await f.call("PUT", assign, { token: asserting, actor: "mgr" });
    expect(asserted.status).toBe(403);
    expect(asserted.body.code).toBe("actor_token_required");
    expect((await f.call("PUT", assign, { token: verified, headers: { "uniora-actor-token": token("mgr") } })).status).toBe(200);
  });

  it("answers 503 when the provider's keys cannot be fetched, and does not accept anything meanwhile", async () => {
    const down = createServer((_req, res) => void (res.writeHead(500), res.end()));
    await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", resolve));
    servers.push(down);
    const { f, verified } = await start(backend, {
      actorTokens: [{ provider: "main", issuer: ISSUER, audience: "uniora", algorithms: ["RS256"], jwksUri: `http://127.0.0.1:${(down.address() as AddressInfo).port}/jwks` }],
    });
    const response = await f.call("PUT", assign, { token: verified, headers: { "uniora-actor-token": token("mgr") } });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("actor_token_unavailable");
  });

  describe("decisions", () => {
    const ask = { identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" };

    it("check, batch, authorize and snapshot take the token, and the question must be about its user", async () => {
      const { f, verified } = await start(backend);
      const headers = { "uniora-actor-token": token("ana") };
      expect((await f.call("POST", "/v1/check", { token: verified, headers, body: ask })).body).toEqual({ allowed: true });
      expect((await f.call("POST", "/v1/check:batch", { token: verified, headers, body: { identity: ask.identity, organizationId: ask.organizationId, checks: [{ permission: "reports.read" }] } })).status).toBe(200);
      expect((await f.call("POST", "/v1/snapshots", { token: verified, headers, body: { identity: ask.identity, organizationId: ask.organizationId, permissions: ["reports.read"] } })).status).toBe(200);
      const mismatch = await f.call("POST", "/v1/check", { token: verified, headers, body: { ...ask, identity: { subject: "bob" } } });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.code).toBe("actor_mismatch");
      const provider = await f.call("POST", "/v1/authorize", { token: verified, headers, body: { ...ask, identity: { provider: "other", subject: "ana" } } });
      expect(provider.body.code).toBe("actor_mismatch");
    });

    it("authorize takes the session from the token: a sensitive policy sees what the provider signed", async () => {
      const { f, verified } = await start(backend);
      const manager = { "uniora-actor-token": token("mgr") };
      const definition = {
        kind: "sensitive",
        effect: "require",
        actions: ["reports.read"],
        condition: { all: [{ lte: [{ ref: "session.authAgeSeconds" }, { value: 300 }] }, { eq: [{ ref: "session.mfa" }, { value: true }] }] },
        denyReason: "step_up_required",
      };
      const created = await f.call("POST", `${ORG}/policies`, { token: verified, headers: manager, body: { key: "recent-mfa", name: "Recent MFA", definition } });
      expect(created.status).toBe(201);
      expect((await f.call("POST", `${ORG}/policies/${created.body.id}/activate`, { token: verified, headers: manager, body: {} })).status).toBe(200);

      const asAna = (extra: Record<string, unknown>) => ({ "uniora-actor-token": token("ana", extra) });
      const strong = await f.call("POST", "/v1/authorize", { token: verified, headers: asAna({ auth_time: nowSeconds() - 60, amr: ["pwd", "mfa"] }), body: ask });
      expect(strong.body).toMatchObject({ allowed: true, decision: "allow" });
      const stale = await f.call("POST", "/v1/authorize", { token: verified, headers: asAna({ auth_time: nowSeconds() - 4000, amr: ["pwd", "mfa"] }), body: ask });
      expect(stale.body).toMatchObject({ allowed: false });
      expect(stale.body.stepUp).toEqual({ policyKeys: ["recent-mfa"] });
      const noMfa = await f.call("POST", "/v1/authorize", { token: verified, headers: asAna({ auth_time: nowSeconds() - 60, amr: ["pwd"] }), body: ask });
      expect(noMfa.body).toMatchObject({ allowed: false });
      const unknown = await f.call("POST", "/v1/authorize", { token: verified, headers: asAna({}), body: ask });
      expect(unknown.body).toMatchObject({ allowed: false });
      // The caller cannot vouch for a session of its own next to a token: facts come from one place.
      const both = await f.call("POST", "/v1/authorize", { token: verified, headers: asAna({}), body: { ...ask, session: { mfa: true, authenticatedAt: new Date().toISOString() } } });
      expect(both.status).toBe(400);
      expect(both.body.errors).toEqual([{ path: "session", code: "too_many" }]);
      // Without a token the application's own statement is still taken, as before.
      const asserted = await f.call("POST", "/v1/authorize", { token: verified, body: { ...ask, session: { mfa: true, authenticatedAt: new Date().toISOString() } } });
      expect(asserted.body).toMatchObject({ allowed: true });
    });
  });
});

describe("without providers", () => {
  it("answers 501 to a token, and refuses requireVerifiedActors at start-up", async () => {
    const f = await startFixture("memory");
    open.push(f);
    const key = (await f.issue()).token;
    const response = await f.call("PUT", assign, { token: key, headers: { "uniora-actor-token": "eyJ" } });
    expect(response.status).toBe(501);
    expect(response.body.code).toBe("actor_token_unsupported");
    await expect(startFixture("memory", { requireVerifiedActors: true })).rejects.toThrow(/actorTokens/);
  });
});
