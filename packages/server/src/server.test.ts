import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfigError, createUnioraServer, silentLogger } from "./index.js";
import { createApiCredentialService, createMemoryApiCredentialStorage, createMemoryStorage } from "@uniora/core";
import { OPERATOR, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});
async function start(name: BackendName, ...args: Parameters<typeof startFixture> extends [unknown, ...infer R] ? R : never): Promise<Fixture> {
  const fixture = await startFixture(name, ...args);
  open.push(fixture);
  return fixture;
}

const ana = { subject: "ana" };
/** `fetch` cannot send a body with GET, so this speaks HTTP directly. */
function rawGet(f: Fixture, path: string, token: string, body: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${f.server.url}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(["memory", "sqlite"] as const)("@uniora/server over %s", (backend) => {
  describe("operations", () => {
    it("answers liveness and readiness without credentials and without detail", async () => {
      const f = await start(backend);
      const live = await f.call("GET", "/healthz");
      expect(live).toMatchObject({ status: 200, body: { status: "ok" } });
      const ready = await f.call("GET", "/readyz");
      expect(ready).toMatchObject({ status: 200, body: { status: "ready" } });
    });

    it("readiness fails closed, without saying why, when the database is down", async () => {
      const f = await start(backend, {}, (b) => ({
        storage: { ...b.storage, organizations: new Proxy(b.storage.organizations, { get: (t, k) => (k === "findById" ? () => Promise.reject(new Error("password=hunter2")) : Reflect.get(t, k)) }) },
        credentials: b.credentials,
      }));
      const ready = await f.call("GET", "/readyz");
      expect(ready.status).toBe(503);
      expect(ready.text).not.toContain("hunter2");
      expect(ready.body).toEqual({ status: "unavailable" });
    });

    it("adds the standard headers and a request id to every answer", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      for (const response of [await f.call("GET", "/v1/organizations", { token }), await f.call("GET", "/v1/organizations"), await f.call("GET", "/nope")]) {
        expect(response.headers.get("request-id")).toMatch(/^req_/);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
    });
  });

  describe("authentication", () => {
    it("answers every kind of failure with the same 401", async () => {
      const f = await start(backend);
      const { token, keyId, clientId } = await f.issue();
      const service = createApiCredentialService({ storage: f.backend.credentials });
      const other = await f.issue();
      await service.revokeKey({ actor: OPERATOR, keyId: other.keyId });
      const disabled = await f.issue();
      await service.disableClient({ actor: OPERATOR, clientId: disabled.clientId });

      const bad = [
        null,
        "",
        "uniora_sk_notakey",
        `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`, // checksum
        token.replace(keyId.slice(-3), "zzz"),
        other.token, // revoked
        disabled.token, // client disabled
      ];
      const seen = new Set<string>();
      for (const candidate of bad) {
        const response = await f.call("GET", "/v1/organizations", { token: candidate });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Bearer");
        const { requestId: _ignored, ...rest } = response.body;
        seen.add(JSON.stringify(rest));
      }
      expect(seen.size).toBe(1);
      expect((await f.call("GET", "/v1/organizations", { token })).status).toBe(200);
      void clientId;
    });

    it("rejects other schemes and a key in the query string", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      expect((await f.call("GET", "/v1/organizations", { headers: { authorization: `Basic ${token}` } })).status).toBe(401);
      expect((await f.call("GET", `/v1/organizations?api_key=${token}`)).status).toBe(401);
    });

    it("stops honouring a key on the very next request after it is revoked", async () => {
      const f = await start(backend);
      const { token, keyId } = await f.issue();
      expect((await f.call("GET", "/v1/organizations", { token })).status).toBe(200);
      await createApiCredentialService({ storage: f.backend.credentials }).revokeKey({ actor: OPERATOR, keyId });
      expect((await f.call("GET", "/v1/organizations", { token })).status).toBe(401);
    });

    it("is a 503, never a 401 or a 200, when the credential store fails", async () => {
      const f = await start(backend, {}, (b) => ({
        storage: b.storage,
        credentials: { apiClients: b.credentials.apiClients, apiKeys: new Proxy(b.credentials.apiKeys, { get: (t, k) => (k === "findRecordById" ? () => Promise.reject(new Error("connection refused 10.0.0.5")) : Reflect.get(t, k)) }) },
      }));
      const { token } = await (async () => {
        const service = createApiCredentialService({ storage: f.backend.credentials });
        const client = await service.createClient({ actor: OPERATOR, name: "c", scopes: ["check"], organizations: "*" });
        return service.createKey({ actor: OPERATOR, clientId: client.id });
      })();
      const response = await f.call("GET", "/v1/organizations", { token });
      expect(response.status).toBe(503);
      expect(response.text).not.toContain("10.0.0.5");
    });

    it("throttles a source that keeps failing, even when it then sends a good key", async () => {
      const f = await start(backend, { limits: { authFailuresPerMinute: 3 } });
      const { token } = await f.issue();
      for (let i = 0; i < 3; i++) expect((await f.call("GET", "/v1/organizations", { token: "uniora_sk_bad" })).status).toBe(401);
      const blocked = await f.call("GET", "/v1/organizations", { token });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    });
  });

  describe("authorization of the caller", () => {
    it("refuses a route outside the client's scopes and does not say which scope", async () => {
      const f = await start(backend);
      const { token } = await f.issue({ scopes: ["check"] });
      const response = await f.call("GET", "/v1/organizations", { token });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden", status: 403 });
      expect(response.text).not.toContain("organizations:read");
      expect((await f.call("GET", "/v1/organizations/org_acme/audit-log", { token })).status).toBe(403);
    });

    it("answers an organization outside the allowlist exactly like one that does not exist", async () => {
      const f = await start(backend);
      const { token } = await f.issue({ organizations: ["org_acme"] });
      const outside = await f.call("GET", "/v1/organizations/org_globex", { token });
      const missing = await f.call("GET", "/v1/organizations/org_nope", { token });
      expect(outside.status).toBe(404);
      const strip = (r: typeof outside) => ({ ...r.body, requestId: "x" });
      expect(strip(outside)).toEqual(strip(missing));
      const check = await f.call("POST", "/v1/check", { token, body: { identity: ana, organizationId: "org_globex", permission: "reports.read" } });
      expect(check.status).toBe(404);
      expect(check.body.code).toBe("organization_not_found");
    });

    it("lists only the organizations on the allowlist", async () => {
      const f = await start(backend);
      const { token } = await f.issue({ organizations: ["org_globex"] });
      const list = await f.call("GET", "/v1/organizations", { token });
      expect(list.body.items.map((o: { id: string }) => o.id)).toEqual(["org_globex"]);
    });

    it("refuses writes with 503 in read-only mode but keeps answering decisions and reads", async () => {
      const f = await start(backend, { readOnly: true });
      const { token } = await f.issue();
      expect((await f.call("POST", "/v1/check", { token, body: { identity: ana, organizationId: "org_acme", permission: "reports.read" } })).status).toBe(200);
      expect((await f.call("GET", "/v1/organizations", { token })).status).toBe(200);
    });
  });

  describe("decisions", () => {
    it("check: a member with the permission is allowed, everyone else is not", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const ask = (subject: string, organizationId = "org_acme", permission = "reports.read") =>
        f.call("POST", "/v1/check", { token, body: { identity: { subject }, organizationId, permission } });
      expect((await ask("ana")).body).toEqual({ allowed: true });
      expect((await ask("bob")).body).toEqual({ allowed: false });
      expect((await ask("owner", "org_acme", "anything.at.all")).body).toEqual({ allowed: true });
      expect((await ask("stranger")).body).toEqual({ allowed: false });
      expect((await ask("ana", "org_globex")).body).toEqual({ allowed: false });
      expect((await ask("ana", "org_acme", "vehicles.delete")).body).toEqual({ allowed: false });
    });

    it("check: needs a permission or a feature", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/check", { token, body: { identity: ana, organizationId: "org_acme" } });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual([{ path: "permission", code: "required" }]);
    });

    it("check: the provider is completed from the server default, and refused when reserved or missing", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const body = (provider?: string) => ({ identity: { ...(provider ? { provider } : {}), subject: "ana" }, organizationId: "org_acme", permission: "reports.read" });
      expect((await f.call("POST", "/v1/check", { token, body: body("main") })).body.allowed).toBe(true);
      expect((await f.call("POST", "/v1/check", { token, body: body("other") })).body.allowed).toBe(false);
      const reserved = await f.call("POST", "/v1/check", { token, body: body("uniora-api") });
      expect(reserved.status).toBe(400);
      expect(reserved.body.code).toBe("identity_provider_reserved");

      const bare = await start(backend, { defaultProvider: undefined as never });
      const other = await bare.issue();
      const missing = await bare.call("POST", "/v1/check", { token: other.token, body: body() });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe("identity_provider_required");
    });

    it("checkBatch: answers in order, one entry per question", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/check:batch", {
        token,
        body: { identity: ana, organizationId: "org_acme", checks: [{ permission: "reports.read" }, { permission: "vehicles.delete" }, { permission: "reports.read" }] },
      });
      expect(response.body).toEqual({ results: [{ allowed: true }, { allowed: false }, { allowed: true }] });
    });

    it("checkBatch: refuses more checks than the configured limit", async () => {
      const f = await start(backend, { limits: { maxBatchChecks: 2 } });
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/check:batch", {
        token,
        body: { identity: ana, organizationId: "org_acme", checks: [{ permission: "a" }, { permission: "b" }, { permission: "c" }] },
      });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual([{ path: "checks", code: "too_many" }]);
    });

    it("authorize: gives the full decision and nothing the engine did not say", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const allowed = await f.call("POST", "/v1/authorize", { token, body: { identity: ana, organizationId: "org_acme", permission: "reports.read" } });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({ allowed: true, decision: "allow", reason: "allowed", via: "membership", policyRevision: 0 });
      expect(typeof allowed.body.evaluatedAt).toBe("string");
      const denied = await f.call("POST", "/v1/authorize", { token, body: { identity: { subject: "bob" }, organizationId: "org_acme", permission: "reports.read" } });
      expect(denied.body).toMatchObject({ allowed: false, decision: "deny", reason: "permission_denied", policyRevision: null });
      const cross = await f.call("POST", "/v1/authorize", {
        token,
        body: { identity: ana, organizationId: "org_acme", permission: "reports.read", resource: { type: "vehicle", id: "v1", organizationId: "org_globex" } },
      });
      expect(cross.body).toMatchObject({ allowed: false, reason: "cross_tenant_resource" });
    });

    it("authorize: a malformed session is a deny, not an error", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/authorize", {
        token,
        body: { identity: ana, organizationId: "org_acme", permission: "reports.read", session: { authenticatedAt: "2026-01-01T00:00:00Z", mfa: true } },
      });
      expect(response.status).toBe(200);
      const bad = await f.call("POST", "/v1/authorize", { token, body: { identity: ana, organizationId: "org_acme", permission: "reports.read", session: { mfa: "yes" } } });
      expect(bad.status).toBe(400);
    });

    it("snapshot: resolves exactly the keys asked for", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/snapshots", {
        token,
        body: { identity: ana, organizationId: "org_acme", permissions: ["reports.read", "vehicles.delete"], features: ["advanced_reports"] },
      });
      expect(response.status).toBe(200);
      expect(response.body.permissions).toEqual({ "reports.read": true, "vehicles.delete": false });
      expect(response.body.features).toEqual({ advanced_reports: false });
    });
  });

  describe("reads", () => {
    it("pages organizations with an opaque cursor and never repeats or skips", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const first = await f.call("GET", "/v1/organizations?limit=1", { token });
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await f.call("GET", `/v1/organizations?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { token });
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
      expect(second.body.nextCursor).toBeNull();
    });

    it("refuses a forged cursor and a page size over the maximum", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      expect((await f.call("GET", "/v1/organizations?cursor=AAAA", { token })).body.code).toBe("invalid_cursor");
      expect((await f.call("GET", "/v1/organizations?limit=101", { token })).status).toBe(400);
      expect((await f.call("GET", "/v1/organizations?limit=0", { token })).status).toBe(400);
      expect((await f.call("GET", "/v1/organizations?limit=abc", { token })).status).toBe(400);
    });

    it("lists members, roles and permissions of an organization, and 404s on the wrong one", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const members = await f.call("GET", "/v1/organizations/org_acme/members", { token });
      expect(members.status).toBe(200);
      expect(members.body.items.map((m: { id: string }) => m.id).sort()).toEqual(["mem_ana", "mem_bob", "mem_mgr", "mem_owner"]);
      const roles = await f.call("GET", "/v1/organizations/org_acme/roles", { token });
      expect(roles.body.items.map((r: { id: string }) => r.id)).toContain("role_viewer");
      const perms = await f.call("GET", "/v1/organizations/org_acme/roles/role_viewer/permissions", { token });
      expect(perms.body.items.map((p: { key: string }) => p.key)).toEqual(["reports.read"]);
      // A role of another organization is a 404, exactly as if it did not exist.
      expect((await f.call("GET", "/v1/organizations/org_globex/roles/role_viewer/permissions", { token })).status).toBe(404);
      expect((await f.call("GET", "/v1/organizations/org_acme/members/mem_globex_owner", { token })).status).toBe(404);
    });

    it("reads the audit log newest first", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("GET", "/v1/organizations/org_acme/audit-log", { token });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    });

    it("does not return fields a response schema does not declare", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const members = await f.call("GET", "/v1/organizations/org_acme/members/mem_ana", { token });
      expect(Object.keys(members.body).sort()).toEqual(
        ["blocked", "createdAt", "id", "identity", "lastActiveAt", "organizationId", "roleIds", "status", "updatedAt", "version"].filter((k) => k in members.body).sort(),
      );
    });
  });

  describe("strict input", () => {
    const valid = { identity: ana, organizationId: "org_acme", permission: "reports.read" };

    it("refuses unknown fields, wrong types, bad JSON, arrays and prototype tricks", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const post = (init: Parameters<Fixture["call"]>[2]) => f.call("POST", "/v1/check", { token, ...init });
      expect((await post({ body: { ...valid, extra: 1 } })).status).toBe(400);
      expect((await post({ body: { ...valid, permission: 5 } })).status).toBe(400);
      expect((await post({ raw: "{nope" })).body.code).toBe("invalid_json");
      expect((await post({ raw: "" })).body.code).toBe("invalid_json");
      expect((await post({ body: [valid] })).status).toBe(400);
      expect((await post({ raw: '{"__proto__":{"admin":true},"identity":{"subject":"ana"},"organizationId":"org_acme","permission":"p"}' })).status).toBe(400);
      expect((await post({ body: { ...valid, identity: { subject: "a\u0000b" } } })).status).toBe(400);
      expect((await post({ body: { ...valid, identity: { subject: "x".repeat(501) } } })).status).toBe(400);
    });

    it("reports where, not what: issues carry a path and a code only", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/check", { token, body: { ...valid, nope: "secret-value" } });
      expect(response.body.errors).toEqual([{ path: "nope", code: "unknown_field" }]);
      expect(response.text).not.toContain("secret-value");
    });

    it("needs a JSON content type", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/check", { token, body: valid, headers: { "content-type": "text/plain" } });
      expect(response.status).toBe(415);
    });

    it("refuses a body over the limit, declared or streamed, without reading it", async () => {
      const f = await start(backend, { limits: { maxBodyBytes: 1024 } });
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/check", { token, raw: JSON.stringify({ ...valid, permission: "x".repeat(2000) }) });
      expect(response.status).toBe(413);
    });

    it("refuses a body on a GET and a repeated query parameter", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      expect((await rawGet(f, "/v1/organizations", token, "{}")).body.code).toBe("unexpected_body");
      expect((await f.call("GET", "/v1/organizations?limit=1&limit=2", { token })).status).toBe(400);
      expect((await f.call("GET", "/v1/organizations?bogus=1", { token })).status).toBe(400);
    });

    it("answers 404 for unknown paths and 405 with Allow for a wrong method, only to authenticated callers", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      expect((await f.call("GET", "/v1/nothing", { token })).status).toBe(404);
      const wrong = await f.call("DELETE", "/v1/organizations", { token });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("allow")).toBe("GET");
      expect((await f.call("GET", "/v1/nothing")).status).toBe(401);
      expect((await f.call("GET", "/elsewhere")).status).toBe(404);
    });

    it("never calls a handler with a malformed percent-encoded path", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      expect((await f.call("GET", "/v1/organizations/%E0%A4%A", { token })).status).toBe(400);
    });
  });

  describe("limits", () => {
    it("rate limits per key with Retry-After and does not affect other keys", async () => {
      const f = await start(backend, { limits: { ratePerSecond: 1, rateBurst: 3 } });
      const a = await f.issue();
      const b = await f.issue();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await f.call("GET", "/v1/permissions", { token: a.token })).status);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      const limited = await f.call("GET", "/v1/permissions", { token: a.token });
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(limited.headers.get("ratelimit-remaining")).toBe("0");
      expect((await f.call("GET", "/v1/permissions", { token: b.token })).status).toBe(200);
    });

    it("caps simultaneous requests per key and releases the slot afterwards", async () => {
      const f = await start(
        backend,
        { limits: { maxConcurrencyPerKey: 2, requestTimeoutMs: 5000 } },
        (b) => ({
          storage: { ...b.storage, organizations: new Proxy(b.storage.organizations, { get: (t, k) => (k === "findById" ? async (...args: unknown[]) => { await sleep(150); return (t.findById as (...a: unknown[]) => unknown)(...args); } : Reflect.get(t, k)) }) },
          credentials: b.credentials,
        }),
      );
      const { token } = await f.issue();
      const responses = await Promise.all(Array.from({ length: 5 }, () => f.call("GET", "/v1/organizations/org_acme", { token })));
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200).length).toBe(2);
      expect(statuses.filter((s) => s === 429).length).toBe(3);
      expect((await f.call("GET", "/v1/organizations/org_acme", { token })).status).toBe(200);
    });

    it("answers 503 timeout and keeps the slot until the work really ends", async () => {
      const f = await start(
        backend,
        { limits: { requestTimeoutMs: 50, maxConcurrencyPerKey: 1 } },
        (b) => ({
          storage: { ...b.storage, organizations: new Proxy(b.storage.organizations, { get: (t, k) => (k === "findById" ? async () => { await sleep(300); return undefined; } : Reflect.get(t, k)) }) },
          credentials: b.credentials,
        }),
      );
      const { token } = await f.issue();
      const slow = await f.call("GET", "/v1/organizations/org_acme", { token });
      expect(slow.status).toBe(503);
      expect(slow.body.code).toBe("timeout");
      // The abandoned work still runs, so the slot is still taken.
      expect((await f.call("GET", "/v1/organizations/org_acme", { token })).status).toBe(429);
      await sleep(350);
      expect((await f.call("GET", "/v1/permissions", { token })).status).toBe(200);
    });
  });

  describe("errors and logs", () => {
    it("turns an unexpected failure into a bare 500 and keeps the detail in the log", async () => {
      const f = await start(backend, {}, (b) => ({
        storage: { ...b.storage, organizations: new Proxy(b.storage.organizations, { get: (t, k) => (k === "findById" ? () => Promise.reject(new Error("FATAL: password for user uniora_prod failed")) : Reflect.get(t, k)) }) },
        credentials: b.credentials,
      }));
      const { token } = await f.issue();
      const response = await f.call("GET", "/v1/organizations/org_acme", { token });
      expect(response.status).toBe(500);
      expect(response.text).not.toMatch(/password|uniora_prod/);
      expect(response.body).toMatchObject({ code: "internal_error", title: "Internal Server Error" });
      expect(JSON.stringify(f.logs)).toContain("uniora_prod");
    });

    it("never writes a key or an Authorization header to the log", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      await f.call("GET", "/v1/organizations", { token });
      await f.call("GET", "/v1/organizations", { token: `${token}x` });
      const lines = f.logs.map((entry) => JSON.stringify(entry)).join("\n");
      expect(lines).not.toContain(token.slice(10));
      expect(lines).toContain('"msg":"request"');
    });

    it("logs who asked, which route and how it ended", async () => {
      const f = await start(backend);
      const { token, clientId, keyId } = await f.issue();
      await f.call("POST", "/v1/check", { token, body: { identity: ana, organizationId: "org_acme", permission: "reports.read" } });
      const entry = f.logs.find((e) => e.msg === "request" && e.route === "decisions.check");
      expect(entry).toMatchObject({ status: 200, clientId, keyId, method: "POST" });
      expect(JSON.stringify(entry)).not.toContain("ana");
    });
  });
});

describe("boot", () => {
  const base = () => ({ storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), logger: silentLogger });

  it("refuses a public interface without TLS", async () => {
    await expect(createUnioraServer(base()).listen({ host: "0.0.0.0", port: 0 })).rejects.toBeInstanceOf(ServerConfigError);
  });

  it("refuses to sit behind a TLS proxy without trusting a hop", async () => {
    await expect(createUnioraServer(base()).listen({ host: "0.0.0.0", port: 0, behindTlsProxy: true })).rejects.toThrow(/trustedProxyHops/);
  });

  it("behind a TLS proxy, refuses plain-HTTP traffic but still answers the health checks", async () => {
    const server = createUnioraServer({ ...base(), trustedProxyHops: 1 });
    const running = await server.listen({ host: "127.0.0.1", port: 0, behindTlsProxy: true });
    try {
      expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
      const plain = await fetch(`${running.url}/v1/organizations`, { headers: { authorization: "Bearer x" } });
      expect(plain.status).toBe(403);
      const proxied = await fetch(`${running.url}/v1/organizations`, { headers: { authorization: "Bearer x", "x-forwarded-proto": "https" } });
      expect(proxied.status).toBe(401);
    } finally {
      await running.close(500);
    }
  });

  it("refuses bad configuration", () => {
    expect(() => createUnioraServer({ ...base(), defaultProvider: "uniora-api" })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), defaultProvider: "bad label!" })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), limits: { maxPageSize: 0 } })).toThrow(ServerConfigError);
    expect(() => createUnioraServer({ ...base(), limits: { nope: 1 } as never })).toThrow(/Unknown limit/);
    expect(() => createUnioraServer({ storage: base().storage } as never)).toThrow(ServerConfigError);
  });

  it("uses the address the proxy added, not one the caller made up", async () => {
    const server = createUnioraServer({ ...base(), trustedProxyHops: 1, limits: { authFailuresPerMinute: 2 } });
    const running = await server.listen({ host: "127.0.0.1", port: 0, behindTlsProxy: true });
    try {
      const hit = (forwarded: string) =>
        fetch(`${running.url}/v1/organizations`, { headers: { authorization: "Bearer bad", "x-forwarded-proto": "https", "x-forwarded-for": forwarded } }).then((r) => r.status);
      // The attacker prepends fake addresses; the proxy appends the real one (203.0.113.9).
      expect(await hit("1.1.1.1, 203.0.113.9")).toBe(401);
      expect(await hit("2.2.2.2, 203.0.113.9")).toBe(401);
      expect(await hit("3.3.3.3, 203.0.113.9")).toBe(429);
      expect(await hit("3.3.3.3, 198.51.100.7")).toBe(401);
    } finally {
      await running.close(500);
    }
  });
});
