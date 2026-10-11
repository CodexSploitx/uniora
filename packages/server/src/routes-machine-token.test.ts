import { afterEach, describe, expect, it } from "vitest";
import { createMemoryApiCredentialStorage, createMemoryStorage } from "@uniora/core";
import { ServerConfigError, createUnioraServer, silentLogger } from "./index.js";
import { BACKENDS, IDP, MACHINE_CLIENT_ID, MACHINE_SUBJECT, machineOptions, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";
import { nowSeconds, signJwt, testKey } from "./test-support/jwt.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});

describe.each(BACKENDS)("machine tokens over %s", (backend: BackendName) => {
  async function start(extra: Parameters<typeof machineOptions>[0] = {}, client: Parameters<Fixture["issue"]>[0] = {}) {
    const f = await startFixture(backend, machineOptions(extra));
    open.push(f);
    const { token } = await f.issue({ id: MACHINE_CLIENT_ID, name: "billing-app", scopes: ["check", "organizations:read", "members:write"], ...client });
    return { f, apiKey: token, jwt: (claims: Record<string, unknown> = {}, subject = MACHINE_SUBJECT) => f.sign(subject, { provider: "machine", claims }) };
  }

  it("acts as the API client the token's subject maps to, with the client's scopes and organizations", async () => {
    const { f, jwt } = await start();
    const organizations = await f.call("GET", "/v1/organizations", { token: jwt() });
    expect(organizations.status).toBe(200);
    expect(organizations.body.items.map((o: { id: string }) => o.id).sort()).toEqual(["org_acme", "org_globex"]);
    const check = await f.call("POST", "/v1/check", { token: jwt(), body: { identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" } });
    expect(check).toMatchObject({ status: 200, body: { allowed: true } });
    // The client's scopes are the ceiling: it has no `organizations:create`.
    expect((await f.call("POST", "/v1/organizations", { token: jwt(), body: { name: "X", owner: { subject: "x" } } })).status).toBe(403);
  });

  it("gives a token with no scope claim nothing unless the provider says so, and refuses a null claim", async () => {
    const strict = await startFixture(backend, machineOptions({ machineTokens: [{ provider: "machines", issuer: IDP.machine.issuer, audience: "uniora-api", algorithms: ["RS256"], jwks: { keys: [IDP.machine.key.publicJwk as never] }, clients: { [MACHINE_SUBJECT]: MACHINE_CLIENT_ID } }] }));
    open.push(strict);
    await strict.issue({ id: MACHINE_CLIENT_ID, name: "billing-app", scopes: ["check", "organizations:read"] });
    const bare = strict.sign(MACHINE_SUBJECT, { provider: "machine" });
    expect((await strict.call("GET", "/v1/organizations", { token: bare })).status).toBe(403);
    expect((await strict.call("GET", "/v1/organizations", { token: strict.sign(MACHINE_SUBJECT, { provider: "machine", claims: { scope: "organizations:read" } }) })).status).toBe(200);
    for (const claims of [{ scope: null }, { scp: null }, { scope: null, scp: ["check"] }]) {
      expect((await strict.call("GET", "/v1/organizations", { token: strict.sign(MACHINE_SUBJECT, { provider: "machine", claims }) })).status, JSON.stringify(claims)).toBe(401);
    }
  });

  it("can tell a machine token from a user token of the same application by a required claim", async () => {
    const f = await startFixture(backend, machineOptions({
      machineTokens: [{ provider: "machines", issuer: IDP.machine.issuer, audience: "uniora-api", algorithms: ["RS256"], jwks: { keys: [IDP.machine.key.publicJwk as never] }, subjectClaim: "azp", requireClaims: { idtyp: "app" }, clients: { [MACHINE_SUBJECT]: MACHINE_CLIENT_ID }, allowUnscopedTokens: true }],
    }));
    open.push(f);
    await f.issue({ id: MACHINE_CLIENT_ID, name: "billing-app", scopes: ["check", "organizations:read"] });
    const make = (claims: Record<string, unknown>) => f.sign("whoever", { provider: "machine", claims: { azp: MACHINE_SUBJECT, ...claims } });
    expect((await f.call("GET", "/v1/organizations", { token: make({ idtyp: "app" }) })).status).toBe(200);
    expect((await f.call("GET", "/v1/organizations", { token: make({}) })).status).toBe(401); // a user's token of the same application
    expect((await f.call("GET", "/v1/organizations", { token: make({ idtyp: "user" }) })).status).toBe(401);
    expect((await f.call("GET", "/v1/organizations", { token: make({ idtyp: ["app"] }) })).status).toBe(401);
  });

  it("keeps the client's organization allowlist", async () => {
    const { f, jwt } = await start({}, { organizations: ["org_acme"] });
    expect((await f.call("GET", "/v1/organizations/org_acme", { token: jwt() })).status).toBe(200);
    expect(await f.call("GET", "/v1/organizations/org_globex", { token: jwt() })).toMatchObject({ status: 404, body: { code: "organization_not_found" } });
  });

  it("lets the token narrow the scopes (`scope` or `scp`) but never widen them", async () => {
    const { f, jwt } = await start();
    const readOnly = jwt({ scope: "organizations:read" });
    expect((await f.call("GET", "/v1/organizations", { token: readOnly })).status).toBe(200);
    expect((await f.call("POST", "/v1/check", { token: readOnly, body: { identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" } })).status).toBe(403);
    expect((await f.call("GET", "/v1/organizations", { token: jwt({ scp: ["organizations:read", "check"] }) })).status).toBe(200);
    // Asking for more than the client has gives nothing extra; naming no UNIORA scope at all gives none.
    expect((await f.call("POST", "/v1/organizations", { token: jwt({ scope: "organizations:create organizations:read" }), body: { name: "X", owner: { subject: "x" } } })).status).toBe(403);
    expect((await f.call("GET", "/v1/organizations", { token: jwt({ scope: "read:users" }) })).status).toBe(403);
    // A malformed scope claim refuses the token.
    expect((await f.call("GET", "/v1/organizations", { token: jwt({ scope: 7 }) })).status).toBe(401);
  });

  it("answers every bad token exactly like a bad key", async () => {
    const { f, jwt } = await start();
    const other = testKey("rsa", "machine-key-1");
    const cases: [string, string][] = [
      ["unmapped subject", jwt({}, "someone-else")],
      ["expired", jwt({ iat: nowSeconds() - 600, exp: nowSeconds() - 300 })],
      ["wrong audience", jwt({ aud: "uniora" })],
      ["wrong issuer", jwt({ iss: "https://evil.example.com/" })],
      ["a user token of another provider", f.sign(MACHINE_SUBJECT, { provider: "main" })],
      ["signed by another key", signJwt({ iss: IDP.machine.issuer, aud: "uniora-api", sub: MACHINE_SUBJECT, exp: nowSeconds() + 300 }, other.privateKey, { alg: "RS256", kid: "machine-key-1" })],
      ["alg none", `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: IDP.machine.issuer, aud: "uniora-api", sub: MACHINE_SUBJECT, exp: nowSeconds() + 300 })).toString("base64url")}.`],
      ["tampered", `${jwt().slice(0, -4)}AAAA`],
      ["garbage", "a.b.c"],
    ];
    const reference = await f.call("GET", "/v1/organizations", { token: "uniora_sk_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_cccccc" });
    for (const [label, token] of cases) {
      const response = await f.call("GET", "/v1/organizations", { token });
      expect(response.status, label).toBe(401);
      expect(response.text.replace(/req_[\w-]+/g, ""), label).toBe(reference.text.replace(/req_[\w-]+/g, ""));
      expect(response.headers.get("www-authenticate"), label).toBe(reference.headers.get("www-authenticate"));
    }
  });

  it("stops at once when the API client is disabled, and the API keys keep working next to the tokens", async () => {
    const { f, jwt, apiKey } = await start();
    expect((await f.call("GET", "/v1/organizations", { token: jwt() })).status).toBe(200);
    expect((await f.call("GET", "/v1/organizations", { token: apiKey })).status).toBe(200);
    const { createApiCredentialService } = await import("@uniora/core");
    await createApiCredentialService({ storage: f.backend.credentials }).disableClient({ actor: { provider: "uniora-cli", subject: "t" }, clientId: MACHINE_CLIENT_ID });
    expect(await f.call("GET", "/v1/organizations", { token: jwt() })).toMatchObject({ status: 401 });
    expect((await f.call("GET", "/v1/organizations", { token: apiKey })).status).toBe(401);
  });

  it("is not accepted where it is not configured, and never as an end user", async () => {
    const plain = await startFixture(backend);
    open.push(plain);
    expect((await plain.call("GET", "/v1/organizations", { token: plain.sign(MACHINE_SUBJECT, { provider: "machine" }) })).status).toBe(401);
    const { f, jwt } = await start();
    // The same token as the user's: refused (it is not from an actor provider).
    const response = await f.call("PUT", "/v1/organizations/org_acme/members/mem_bob/roles/role_viewer", { token: jwt(), headers: { "uniora-actor-token": jwt() } });
    expect([401, 403, 501]).toContain(response.status);
  });

  it("stamps the audit trail with the credential kind", async () => {
    const { f, jwt } = await start({}, { scopes: ["members:write", "actor:assert"] });
    const response = await f.call("PUT", "/v1/organizations/org_acme/members/mem_bob/roles/role_viewer", { token: jwt(), actor: "mgr" });
    expect(response.status).toBe(200);
    const entries = await f.backend.storage.auditLogs.listRecent({ limit: 10 });
    const via = entries.find((entry) => entry.action.startsWith("membership."))?.metadata?.via as Record<string, unknown>;
    expect(via).toMatchObject({ apiClientId: MACHINE_CLIENT_ID, credential: "token", requestId: response.headers.get("request-id") });
    expect(String(via.keyId)).toMatch(/^oidc_[0-9a-f]{16}$/);
  });

  it("rate limits per machine identity, with its own bucket", async () => {
    const { f, jwt } = await start({ limits: { ratePerSecond: 1, rateBurst: 2 } });
    const statuses = [];
    for (let index = 0; index < 4; index++) statuses.push((await f.call("GET", "/v1/organizations", { token: jwt() })).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("counts bad tokens toward the failure throttle of their source", async () => {
    const { f } = await start({ limits: { authFailuresPerMinute: 3 } });
    for (let index = 0; index < 3; index++) expect((await f.call("GET", "/v1/organizations", { token: "a.b.c" })).status).toBe(401);
    expect((await f.call("GET", "/v1/organizations", { token: "a.b.c" })).status).toBe(429);
  });

  it("is a 503, not a 401, when the provider's keys cannot be fetched", async () => {
    const { f, jwt } = await start({
      machineTokens: [{ provider: "machines", issuer: IDP.machine.issuer, audience: "uniora-api", algorithms: ["RS256"], jwksUri: "https://127.0.0.1:1/jwks.json", clients: { [MACHINE_SUBJECT]: MACHINE_CLIENT_ID } }],
    });
    const response = await f.call("GET", "/v1/organizations", { token: jwt() });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("unavailable");
  });
});

describe("machine token configuration", () => {
  const base = () => ({ storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), logger: silentLogger });
  const provider = (extra: Record<string, unknown> = {}) => ({ provider: "machines", issuer: "https://m.example.com/", audience: "uniora-api", algorithms: ["RS256"] as const, jwks: { keys: [IDP.machine.key.publicJwk as never] }, clients: { app: "apc_x" }, ...extra });

  it("needs the machines it accepts, valid providers and an audience of its own", () => {
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider()] })).not.toThrow();
    expect(() => createUnioraServer({ ...base(), machineTokens: [] })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ clients: undefined })] })).toThrow(/clients/);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ clients: {} })] })).toThrow(/clients/);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ clients: { app: 7 } })] })).toThrow(/API client id/);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ audience: undefined })] })).toThrow(/audience/);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ algorithms: ["none"] })] })).toThrow(/algorithms/);
    // A subject claim other than `sub` (azp, client_id) also names users' tokens: the config must say how to tell them apart.
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ subjectClaim: "azp" })] })).toThrow(/requireClaims/);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ subjectClaim: "azp", requireClaims: { idtyp: "app" } })] })).not.toThrow();
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ subjectClaim: "client_id", requireClaims: {} })] })).not.toThrow();
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ requireClaims: { gty: [] } })] })).toThrow(/requireClaims/);
    expect(() => createUnioraServer({ ...base(), machineTokens: [provider({ allowUnscopedTokens: "yes" })] })).toThrow(/allowUnscopedTokens/);
    const user = { provider: "main", issuer: "https://m.example.com/", audience: "uniora-api", algorithms: ["RS256"] as const, jwks: { keys: [IDP.main.key.publicJwk as never] } };
    expect(() => createUnioraServer({ ...base(), actorTokens: [user], machineTokens: [provider()] })).toThrow(/audience of their own/);
    expect(() => createUnioraServer({ ...base(), actorTokens: [{ ...user, audience: "uniora" }], machineTokens: [provider()] })).not.toThrow();
  });
});
