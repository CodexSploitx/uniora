import Database from "better-sqlite3";
import { createApiCredentialService, createMemoryApiCredentialStorage, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import { createUnioraServer, silentLogger } from "@uniora/server";
import type { RunningServer } from "@uniora/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnioraApiError, UnioraConnectionError, createUnioraClient, paginate } from "./index.js";
import type { UnioraClient } from "./index.js";

const OPERATOR = { provider: "uniora-cli", subject: "tests" };
let server: RunningServer;
let storage = createMemoryStorage();
let uniora: UnioraClient;
let key: string;
let clientId: string;

async function seed() {
  for (const permission of ["reports.read", "members.roles.manage", "members.invite", "roles.manage"]) await storage.permissions.register({ key: permission });
  await createOrganizationWithOwner(storage, { organizationId: "org_acme", organizationName: "Acme", ownerRoleId: "role_owner", membershipId: "mem_owner", ownerIdentity: { provider: "main", subject: "owner" } });
  await storage.roles.create({ id: "role_viewer", organizationId: "org_acme", name: "Viewer", permissionKeys: ["reports.read"] });
  await storage.roles.create({ id: "role_manager", organizationId: "org_acme", name: "Manager", permissionKeys: ["members.roles.manage", "reports.read"] });
  await storage.memberships.create({ id: "mem_mgr", organizationId: "org_acme", identity: { provider: "main", subject: "mgr" }, roleIds: ["role_manager"] });
  await storage.memberships.create({ id: "mem_ana", organizationId: "org_acme", identity: { provider: "main", subject: "ana" }, roleIds: ["role_viewer"] });
  await storage.memberships.create({ id: "mem_bob", organizationId: "org_acme", identity: { provider: "main", subject: "bob" } });
}

beforeAll(async () => {
  void Database;
  const credentials = createMemoryApiCredentialStorage();
  await seed();
  const service = createApiCredentialService({ storage: credentials });
  const client = await service.createClient({
    actor: OPERATOR,
    name: "backend",
    scopes: ["check", "organizations:read", "organizations:create", "members:write", "actor:assert"],
    organizations: "*",
  });
  clientId = client.id;
  key = (await service.createKey({ actor: OPERATOR, clientId })).token;
  server = await createUnioraServer({ storage, credentials, defaultProvider: "main", logger: silentLogger }).listen({ port: 0 });
  uniora = createUnioraClient({ baseUrl: server.url, apiKey: key });
});
afterAll(async () => {
  await server.close(500);
});

describe("createUnioraClient", () => {
  it("answers decisions", async () => {
    expect(await uniora.decisions.check({ identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" })).toEqual({ allowed: true });
    expect(await uniora.decisions.check({ identity: { subject: "bob" }, organizationId: "org_acme", permission: "reports.read" })).toEqual({ allowed: false });
    const batch = await uniora.decisions.checkBatch({ identity: { subject: "ana" }, organizationId: "org_acme", checks: [{ permission: "reports.read" }, { permission: "nope" }] });
    expect(batch.results).toEqual([{ allowed: true }, { allowed: false }]);
    const decision = await uniora.decisions.authorize({ identity: { subject: "ana" }, organizationId: "org_acme", permission: "reports.read" });
    expect(decision).toMatchObject({ allowed: true, decision: "allow", reason: "allowed" });
  });

  it("changes things on behalf of an end user, with a version", async () => {
    const member = await uniora.members.assignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { subject: "mgr" } });
    expect(member.roleIds).toEqual(["role_viewer"]);
    await expect(uniora.members.assignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { subject: "mgr" }, ifMatch: member.version - 1 })).rejects.toMatchObject({ code: "membership_version_conflict", status: 412 });
    const back = await uniora.members.unassignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { subject: "mgr" }, ifMatch: member.version });
    expect(back.roleIds).toEqual([]);
  });

  it("raises UnioraApiError with the stable code, the request id and the issues", async () => {
    const error = await uniora.decisions.check({ identity: { subject: "ana" }, organizationId: "org_acme" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnioraApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid_request", issues: [{ path: "permission", code: "required" }] });
    expect((error as UnioraApiError).requestId).toMatch(/^req_/);
    await expect(uniora.organizations.get({ organizationId: "nope" })).rejects.toMatchObject({ status: 404, code: "organization_not_found" });
    await expect(uniora.members.assignRole({ organizationId: "org_acme", membershipId: "mem_mgr", roleId: "role_viewer" }, { actor: { subject: "mgr" } })).rejects.toMatchObject({ code: "access_self_change" });
  });

  it("creates an organization once even when the call is retried (it adds an Idempotency-Key by itself)", async () => {
    const created = await uniora.organizations.create({ name: "Globex", owner: { subject: "founder" } });
    expect(created.organization.name).toBe("Globex");
    const key = "retry-1";
    const a = await uniora.organizations.create({ name: "Initech", owner: { subject: "founder-2" } }, { idempotencyKey: key });
    const b = await uniora.organizations.create({ name: "Initech", owner: { subject: "founder-2" } }, { idempotencyKey: key });
    expect(b.replayed).toBe(true);
    expect(b.organization.id).toBe(a.organization.id);
  });

  it("walks every page", async () => {
    const ids: string[] = [];
    for await (const member of paginate((cursor) => uniora.members.list({ organizationId: "org_acme", limit: 2, ...(cursor ? { cursor } : {}) }))) ids.push(member.id);
    expect(ids.sort()).toEqual(["mem_ana", "mem_bob", "mem_mgr", "mem_owner"]);
  });

  it("refuses wrong input before any request leaves", async () => {
    // @ts-expect-error unknown field
    await expect(uniora.decisions.check({ identity: { subject: "a" }, organizationId: "o", permission: "p", extra: 1 })).rejects.toThrow(/unknown input/);
    // @ts-expect-error a delegated call needs an actor
    await expect(uniora.members.unblock({ organizationId: "org_acme", membershipId: "mem_bob" })).rejects.toThrow(/actor/);
    // @ts-expect-error a decision takes no actor
    await expect(uniora.decisions.check({ identity: { subject: "a" }, organizationId: "o", permission: "p" }, { actor: { subject: "x" } })).rejects.toThrow(/no actor/);
  });
});

describe("construction", () => {
  it("refuses a browser, a cleartext URL, a malformed key and bad numbers", () => {
    const apiKey = key;
    expect(() => createUnioraClient({ baseUrl: "http://uniora.example.com", apiKey })).toThrow(/https/);
    expect(() => createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: "nope" })).toThrow(/API key/);
    expect(() => createUnioraClient({ baseUrl: "https://user:pass@uniora.example.com", apiKey })).toThrow(/credentials/);
    expect(() => createUnioraClient({ baseUrl: "not a url", apiKey })).toThrow(/URL/);
    expect(() => createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey, retries: -1 })).toThrow(/retries/);
    expect(() => createUnioraClient({ baseUrl: "http://10.0.0.5:8787", apiKey, allowInsecureHttp: true })).not.toThrow();
    expect(() => createUnioraClient({ baseUrl: "http://127.0.0.1:8787", apiKey })).not.toThrow();
    const g = globalThis as { window?: unknown };
    g.window = { document: {} };
    try {
      expect(() => createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey })).toThrow(/never in a browser/);
      expect(() => createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey, dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      delete g.window;
    }
  });

  it("never puts the key in an error message", async () => {
    const dead = createUnioraClient({ baseUrl: "http://127.0.0.1:9", apiKey: key, retries: 0, timeoutMs: 500 });
    const error = await dead.organizations.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnioraConnectionError);
    expect(String((error as Error).message)).not.toContain(key);
  });
});

describe("retries", () => {
  const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ type: `urn:uniora:error:${code}`, title: "x", status, code, requestId: "req_1" }), { status, headers: { "content-type": "application/problem+json", ...headers } });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  function scripted(responses: (Response | Error)[]) {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    const waits: number[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string> });
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const client = createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: key, fetch: fetchStub, sleep: async (ms) => void waits.push(ms) });
    return { client, seen, waits };
  }

  it("retries a read on a network error and on 503, waiting what the server asked", async () => {
    const { client, seen, waits } = scripted([new TypeError("fetch failed"), problem(503, "timeout", { "retry-after": "2" }), ok({ items: [], nextCursor: null })]);
    expect(await client.organizations.list()).toEqual({ items: [], nextCursor: null });
    expect(seen).toHaveLength(3);
    expect(waits[1]).toBe(2000);
  });

  it("gives up after the configured retries with the last error", async () => {
    const { client, seen } = scripted([problem(503, "timeout"), problem(503, "timeout"), problem(503, "timeout"), ok({})]);
    await expect(client.organizations.list()).rejects.toMatchObject({ status: 503, code: "timeout" });
    expect(seen).toHaveLength(3);
  });

  it("does not retry a change that may have happened, but does retry one the server refused up front", async () => {
    const lost = scripted([problem(503, "timeout"), ok({})]);
    await expect(lost.client.members.unblock({ organizationId: "o", membershipId: "m" }, { actor: { subject: "mgr" } })).rejects.toMatchObject({ code: "timeout" });
    expect(lost.seen).toHaveLength(1);
    const network = scripted([new TypeError("fetch failed"), ok({})]);
    await expect(network.client.members.unblock({ organizationId: "o", membershipId: "m" }, { actor: { subject: "mgr" } })).rejects.toBeInstanceOf(UnioraConnectionError);
    expect(network.seen).toHaveLength(1);

    const limited = scripted([problem(429, "rate_limited", { "retry-after": "1" }), ok({ id: "m" })]);
    await limited.client.members.unblock({ organizationId: "o", membershipId: "m" }, { actor: { subject: "mgr" } });
    expect(limited.seen).toHaveLength(2);
  });

  it("retries a creation with the SAME idempotency key", async () => {
    const { client, seen } = scripted([new TypeError("fetch failed"), ok({ organization: {}, replayed: true })]);
    await client.organizations.create({ name: "X", owner: { subject: "s" } });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(seen[0]!.headers["idempotency-key"]).toBe(seen[1]!.headers["idempotency-key"]);
  });

  it("with retries off, a creation carries no key of its own", async () => {
    const { client, seen } = scripted([ok({ organization: {} })]);
    await client.organizations.create({ name: "X", owner: { subject: "s" } }, { retries: 0 });
    expect(seen[0]!.headers["idempotency-key"]).toBeUndefined();
  });

  it("times out and reports it", async () => {
    const slow = createUnioraClient({
      baseUrl: "https://uniora.example.com",
      apiKey: key,
      retries: 0,
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch,
    });
    await expect(slow.organizations.list()).rejects.toThrow(/within 20 ms/);
  });

  it("sends the actor percent-encoded and the version quoted", async () => {
    const { client, seen } = scripted([ok({ id: "m", version: 4 })]);
    await client.members.unblock({ organizationId: "o/1", membershipId: "m" }, { actor: { subject: "auth0|ñ", provider: "p1" }, ifMatch: 3 });
    expect(seen[0]!.url).toBe("https://uniora.example.com/v1/organizations/o%2F1/members/m/unblock");
    expect(seen[0]!.headers["uniora-actor-subject"]).toBe(encodeURIComponent("auth0|ñ"));
    expect(seen[0]!.headers["uniora-actor-provider"]).toBe("p1");
    expect(seen[0]!.headers["if-match"]).toBe('"3"');
  });
});
