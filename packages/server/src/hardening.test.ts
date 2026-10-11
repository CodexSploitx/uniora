import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createUnioraServer, silentLogger, ServerConfigError } from "./index.js";
import { throttleKey } from "./server.js";
import { isLoopbackHost } from "./config.js";
import { createMemoryApiCredentialStorage, createMemoryStorage } from "@uniora/core";
import { BACKENDS, startFixture } from "./test-support/harness.js";
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

/** One request written byte for byte, so the target is not normalized on the way (fetch would). */
function raw(f: Fixture, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(f.server.port, "127.0.0.1", () => socket.write(request));
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}
const statusOf = (response: string) => Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(BACKENDS)("request pipeline hardening over %s", (backend) => {
  describe("request target", () => {
    it.each(["//x/v1/organizations", "/\\x/v1/organizations", "/v1/./organizations", "/v1/x/../organizations", "/v1/%2e%2e/organizations", "/v1/%2E/organizations", "///v1/organizations", "//"])(
      "does not route the ambiguous target %s",
      async (target) => {
        const f = await start(backend);
        const { token } = await f.issue();
        const response = await raw(f, `GET ${target} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
        expect(statusOf(response)).toBe(404);
        expect(response).not.toContain("ERR_INVALID_URL");
      },
    );

    it("keeps routing the plain target, with its query", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      expect((await f.call("GET", "/v1/organizations?limit=1", { token })).status).toBe(200);
    });

    it("also refuses the ambiguous health paths and answers HEAD on the real ones", async () => {
      const f = await start(backend);
      expect(statusOf(await raw(f, "GET //healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))).toBe(404);
      expect(statusOf(await raw(f, "HEAD /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))).toBe(200);
      expect(statusOf(await raw(f, "HEAD /readyz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))).toBe(200);
    });

    it("reports a query key that would hit Object.prototype as an unknown field", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("GET", "/v1/organizations?__proto__=x", { token });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual([{ path: "__proto__", code: "unknown_field" }]);
    });
  });

  describe("errors", () => {
    it("never takes the code of a driver or Node error for its own: it is a 500", async () => {
      const f = await start(backend, {}, (b) => ({
        storage: {
          ...b.storage,
          organizations: new Proxy(b.storage.organizations, {
            get: (target, key) =>
              key === "findById"
                ? () => Promise.reject(Object.assign(new Error("SQLITE_BUSY: database is locked"), { name: "SqliteError", code: "SQLITE_BUSY" }))
                : Reflect.get(target, key),
          }),
        },
        credentials: b.credentials,
      }));
      const { token } = await f.issue();
      const response = await f.call("GET", "/v1/organizations/org_acme", { token });
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("internal_error");
      expect(response.text).not.toContain("SQLITE");
      expect(f.logs.some((entry) => entry.level === "error" && entry.msg === "request failed")).toBe(true);
    });
  });

  describe("If-Match", () => {
    it.each(['"0"', '"00"', 'W/"0"', '"-1"', '"01"'])("refuses %s as a malformed precondition, never a 500", async (value) => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/organizations/org_acme/members/mem_ana/block", { token, actor: "mgr", headers: { "if-match": value }, body: {} });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual([{ path: "If-Match", code: "pattern" }]);
    });
  });

  describe("readiness", () => {
    it("shares one probe between concurrent callers and does not count health checks as load", async () => {
      let probes = 0;
      const f = await start(backend, { limits: { maxInFlight: 2 } }, (b) => ({
        storage: {
          ...b.storage,
          organizations: new Proxy(b.storage.organizations, {
            get: (target, key) =>
              key === "findById"
                ? (id: string) => {
                    if (id === "uniora_ready_probe") {
                      probes += 1;
                      return sleep(150).then(() => null);
                    }
                    return (target as any).findById(id);
                  }
                : Reflect.get(target, key),
          }),
        },
        credentials: b.credentials,
      }));
      const { token } = await f.issue();
      const probing = Promise.all(Array.from({ length: 40 }, () => f.call("GET", "/readyz")));
      await sleep(30);
      // Forty slow probes are in flight; an authenticated call is still served (they hold no slot).
      expect((await f.call("GET", "/v1/organizations", { token })).status).toBe(200);
      const answers = await probing;
      expect(answers.every((answer) => answer.status === 200)).toBe(true);
      expect(probes).toBe(1);
      await f.call("GET", "/readyz");
      expect(probes).toBe(1); // cached for a moment
    });

    it("logs a failing probe once, not once per caller", async () => {
      const f = await start(backend, {}, (b) => ({
        storage: { ...b.storage, organizations: new Proxy(b.storage.organizations, { get: (t, k) => (k === "findById" ? () => sleep(50).then(() => Promise.reject(new Error("down"))) : Reflect.get(t, k)) }) },
        credentials: b.credentials,
      }));
      const answers = await Promise.all(Array.from({ length: 20 }, () => f.call("GET", "/readyz")));
      expect(answers.every((answer) => answer.status === 503)).toBe(true);
      expect(f.logs.filter((entry) => entry.msg === "readiness check failed")).toHaveLength(1);
    });
  });

  describe("failures after the answer", () => {
    it("logs a write that fails after its caller already got the 503 timeout", async () => {
      const f = await start(backend, { limits: { requestTimeoutMs: 50 } }, (b) => ({
        storage: {
          ...b.storage,
          organizations: new Proxy(b.storage.organizations, {
            get: (target, key) => (key === "findById" ? () => sleep(250).then(() => Promise.reject(new Error("db exploded"))) : Reflect.get(target, key)),
          }),
        },
        credentials: b.credentials,
      }));
      const { token } = await f.issue();
      const response = await f.call("GET", "/v1/organizations/org_acme", { token });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("timeout");
      await sleep(400);
      const late = f.logs.find((entry) => entry.msg === "request failed after its deadline");
      expect(late).toBeDefined();
      expect(JSON.stringify(response.body)).not.toContain("exploded");
    });

    it("survives a logger that throws", async () => {
      const f = await start(backend, {
        logger: () => {
          throw new Error("sink down");
        },
      });
      expect((await f.call("GET", "/healthz")).status).toBe(200);
      expect((await f.call("GET", "/v1/organizations")).status).toBe(401);
    });
  });

  describe("transport", () => {
    it("keeps the TLS-proxy guard per listener, not per server", async () => {
      const server = createUnioraServer({ storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), logger: silentLogger, trustedProxyHops: 1 });
      const guarded = await server.listen({ port: 0, behindTlsProxy: true });
      const plain = await server.listen({ port: 0 });
      try {
        const first = await fetch(`${guarded.url}/v1/organizations`);
        expect(first.status).toBe(403);
        expect(((await first.json()) as { code: string }).code).toBe("tls_required");
        const upper = await fetch(`${guarded.url}/v1/organizations`, { headers: { "x-forwarded-proto": "HTTPS" } });
        expect(upper.status).toBe(401);
        const chained = await fetch(`${guarded.url}/v1/organizations`, { headers: { "x-forwarded-proto": "http, https" } });
        expect(chained.status).toBe(401);
        const spoofed = await fetch(`${guarded.url}/v1/organizations`, { headers: { "x-forwarded-proto": "https, http" } });
        expect(spoofed.status).toBe(403);
        expect((await fetch(`${plain.url}/v1/organizations`)).status).toBe(401);
        expect((await fetch(`${guarded.url}/v1/organizations`)).status).toBe(403);
      } finally {
        await guarded.close(500);
        await plain.close(500);
      }
    });

    it("closes a client that never finishes its headers near the configured time, not after 30 seconds", async () => {
      const server = createUnioraServer({
        storage: createMemoryStorage(),
        credentials: createMemoryApiCredentialStorage(),
        logger: silentLogger,
        limits: { headersTimeoutMs: 600, requestBodyTimeoutMs: 600 },
      });
      const running = await server.listen({ port: 0 });
      try {
        const started = Date.now();
        await new Promise<void>((resolve) => {
          const socket = connect(running.port, "127.0.0.1", () => socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n"));
          socket.on("close", () => resolve());
          socket.resume();
          socket.on("error", () => undefined);
        });
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        await running.close(500);
      }
    }, 10_000);

    it("answers the request in flight with Connection: close while shutting down, and finishes without waiting for keep-alive", async () => {
      const storage = createMemoryStorage();
      const slow = new Proxy(storage.organizations, { get: (t, k) => (k === "findById" ? () => sleep(300).then(() => null) : Reflect.get(t, k)) });
      const server = createUnioraServer({ storage: { ...storage, organizations: slow }, credentials: createMemoryApiCredentialStorage(), logger: silentLogger });
      const running = await server.listen({ port: 0 });
      const socket = connect(running.port, "127.0.0.1");
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write("GET /readyz HTTP/1.1\r\nHost: x\r\n\r\n");
      await sleep(100);
      const started = Date.now();
      await running.close(10_000);
      expect(Date.now() - started).toBeLessThan(2_000);
      await sleep(50);
      expect(text).toMatch(/^HTTP\/1\.1 200/);
      expect(text.toLowerCase()).toContain("connection: close");
      socket.destroy();
    });
  });

  describe("failure throttle source", () => {
    it("counts an IPv6 client by its /64 and an IPv4-mapped one as IPv4", () => {
      expect(throttleKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(throttleKey("2001:db8:1:2:1::1"));
      expect(throttleKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).not.toBe(throttleKey("2001:db8:1:3:aaaa:bbbb:cccc:dddd"));
      expect(throttleKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
      expect(throttleKey("203.0.113.9")).toBe("203.0.113.9");
      expect(throttleKey("2001:DB8::1")).toBe(throttleKey("2001:db8:0:0::99"));
    });
  });

  describe("configuration", () => {
    it("recognizes only real loopback addresses", () => {
      for (const host of ["localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.1", "127.5.6.7"]) expect(isLoopbackHost(host)).toBe(true);
      for (const host of ["127.999.0.1", "127.1", "0.0.0.0", "10.0.0.1", "::", "example.com", "127.0.0.1.example.com"]) expect(isLoopbackHost(host)).toBe(false);
    });

    it("refuses an engine decision auditor, which would let a check key write audit rows under any name", () => {
      expect(() =>
        createUnioraServer({ storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), engine: { onDecision: () => undefined } }),
      ).toThrow(ServerConfigError);
    });

    it("caps the page size below what the repositories can serve", () => {
      const base = { storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage() };
      expect(() => createUnioraServer({ ...base, limits: { maxPageSize: 200 } })).toThrow(ServerConfigError);
      expect(() => createUnioraServer({ ...base, limits: { maxPageSize: 199 } })).not.toThrow();
    });
  });

  describe("reserved providers", () => {
    it.each(["UNIORA-API", "Uniora-Studio", "uniora-cli", "UNIORA-PLATFORM"])("refuses %s as an actor provider", async (provider) => {
      const f = await start(backend);
      const { token } = await f.issue();
      const response = await f.call("POST", "/v1/organizations/org_acme/members/mem_ana/block", { token, actor: "mgr", headers: { "uniora-actor-provider": provider }, body: {} });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("identity_provider_reserved");
    });
  });

  describe("routes", () => {
    it("does not take an id for a role, a team or a team membership from the caller", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const attempts: [string, string, unknown][] = [
        ["POST", "/v1/organizations/org_acme/roles", { id: "role_owner", name: "Pwn", permissionKeys: [] }],
        ["POST", "/v1/organizations/org_acme/roles/role_viewer/clone", { id: "role_globex_owner", name: "Copy" }],
        ["POST", "/v1/organizations/org_acme/teams", { id: "team_x", name: "X" }],
        ["POST", "/v1/organizations/org_acme/team-moves", { id: "tm_x", membershipId: "mem_ana", fromTeamId: "a", toTeamId: "b" }],
      ];
      for (const [method, path, body] of attempts) {
        const response = await f.call(method, path, { token, actor: "mgr", body });
        expect(response.status, path).toBe(400);
        expect(response.body.errors).toContainEqual({ path: "id", code: "unknown_field" });
      }
      const owner = await f.call("GET", "/v1/organizations/org_acme/roles", { token });
      expect(owner.body.items.find((role: { id: string }) => role.id === "role_owner")).toMatchObject({ isOwnerRole: true });
    });

    it("answers permission_not_found for a key nobody registered, on every backend", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const created = await f.call("POST", "/v1/organizations/org_acme/roles", { token, actor: "owner", body: { name: "Ghost", permissionKeys: ["perm.nope"] } });
      expect(created.status).toBe(404);
      expect(created.body.code).toBe("permission_not_found");
      const granted = await f.call("PUT", "/v1/organizations/org_acme/roles/role_viewer/permissions/perm.nope", { token, actor: "owner" });
      expect(granted).toMatchObject({ status: 404, body: { code: "permission_not_found" } });
      const set = await f.call("PUT", "/v1/organizations/org_acme/roles/role_viewer/permissions", { token, actor: "owner", body: { permissionKeys: ["perm.nope"] } });
      expect(set.status).toBe(404);
      expect(set.text).not.toMatch(/SQLITE|constraint/i);
    });

    it("does not tell somebody who may not invite which roles or teams exist", async () => {
      const f = await start(backend);
      const { token } = await f.issue();
      const answers = [];
      for (const actor of ["ana", "nobody"]) {
        for (const body of [
          { email: "x@example.com", roleIds: ["role_viewer"] },
          { email: "x@example.com", roleIds: ["role_missing"] },
          { email: "x@example.com", roleIds: ["role_owner"] },
          { email: "x@example.com", roleIds: ["role_viewer"], teamIds: ["team_missing"] },
        ]) {
          const response = await f.call("POST", "/v1/organizations/org_acme/invitations", { token, actor, body });
          answers.push([response.status, response.body.code]);
        }
      }
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
      expect(answers[0]![0]).toBe(403);
    });
  });
});
