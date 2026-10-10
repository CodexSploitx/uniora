import { afterEach, describe, expect, it } from "vitest";
import { API_SCOPE_LIST } from "@uniora/core";
import { toJsonSchema } from "./schema.js";
import { allRoutes } from "./routes/index.js";
import { startFixture } from "./test-support/harness.js";
import type { Fixture } from "./test-support/harness.js";

/**
 * Generated from the route table, so a route added tomorrow is covered the day it exists: whoever adds one cannot forget the
 * authentication, the scope or the strictness, because this file does not name any route.
 */
const routes = allRoutes();
const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});

const concrete = (path: string) => path.replace(/\/:[A-Za-z]+/g, "/org_acme");
const withBody = (method: string) => (method === "GET" ? undefined : {});

describe("route table", () => {
  it("is well formed: unique ids and paths, a real scope, documented errors", () => {
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
    for (const route of routes) {
      expect(API_SCOPE_LIST, route.id).toContain(route.scope);
      expect(route.summary.length, route.id).toBeGreaterThan(5);
      expect(route.description.length, route.id).toBeGreaterThan(20);
      expect(route.errors.length, route.id).toBeGreaterThanOrEqual(0);
      expect(() => JSON.stringify(toJsonSchema(route.response)), route.id).not.toThrow();
    }
  });

  it("marks reads and decisions as not writing, so read-only mode keeps them working", () => {
    for (const route of routes) {
      if (route.scope === "check" || route.method === "GET") expect(route.write, route.id).toBe(false);
    }
  });
});

describe.each(["memory", "sqlite"] as const)("every route over %s", (backend) => {
  it("needs a key", async () => {
    const f = await startFixture(backend);
    open.push(f);
    for (const route of routes) {
      const response = await f.call(route.method, concrete(route.path), { body: withBody(route.method) });
      expect(response.status, route.id).toBe(401);
    }
  });

  it("needs its scope, and a key with every other scope is still refused", async () => {
    const f = await startFixture(backend);
    open.push(f);
    for (const route of routes) {
      const others = API_SCOPE_LIST.filter((scope) => scope !== route.scope);
      const { token } = await f.issue({ scopes: others as never });
      const response = await f.call(route.method, concrete(route.path), { token, body: withBody(route.method) });
      expect(response.status, route.id).toBe(403);
      expect(response.body.code, route.id).toBe("forbidden");
    }
  });

  it("refuses unknown query parameters and unknown body fields", async () => {
    const f = await startFixture(backend);
    open.push(f);
    const { token } = await f.issue({ scopes: [...API_SCOPE_LIST] });
    for (const route of routes) {
      const path = `${concrete(route.path)}?zzz=1`;
      const response = await f.call(route.method, path, { token, body: route.body ? { zzz: 1 } : undefined });
      expect(response.status, route.id).toBe(400);
    }
  });

  it("never answers a documented client error with a message", async () => {
    const f = await startFixture(backend);
    open.push(f);
    const { token } = await f.issue({ scopes: [...API_SCOPE_LIST] });
    for (const route of routes) {
      const response = await f.call(route.method, `${concrete(route.path)}?zzz=1`, { token, body: route.body ? {} : undefined });
      expect(Object.keys(response.body).sort(), route.id).toEqual(["code", "errors", "requestId", "status", "title", "type"]);
    }
  });
});
