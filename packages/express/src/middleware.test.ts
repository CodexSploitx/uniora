import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthorizationEngine, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import type { AccessCheckInput, AuthorizationEngine, CanInput, Identity } from "@uniora/core";
import { authorize, requireFeature, requirePermission } from "./middleware.js";

const identity: Identity = { provider: "supabase", subject: "user-1" };

interface Calls {
  can: CanInput[];
  access: AccessCheckInput[];
}

function fakeEngine(answer: boolean | "throw"): { engine: AuthorizationEngine; calls: Calls } {
  const calls: Calls = { can: [], access: [] };
  const respond = async () => {
    if (answer === "throw") throw new Error("database down");
    return answer;
  };
  const engine: AuthorizationEngine = {
    can: async (input) => (calls.can.push(input), respond()),
    access: { check: async (input) => (calls.access.push(input), respond()) },
  };
  return { engine, calls };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Real Express app; `handler` is the route under test, `reached` records whether it ran. */
async function serve(setup: (app: express.Express, reached: { value: boolean }) => void) {
  const app = express();
  const reached = { value: false };
  setup(app, reached);
  // Express' default error handler would print the stack to stderr; keep the test output quiet.
  app.use((_err: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { reached, get: (path: string) => fetch(base + path) };
}

const resolveFromParams = (req: Request) => ({ identity, organizationId: String(req.params.orgId) });

describe("requirePermission", () => {
  it("lets the request through when the engine allows it, using engine.can()", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get, reached } = await serve((app, r) => {
      app.get("/orgs/:orgId", requirePermission(engine, "vehicles.read", { resolve: resolveFromParams }), (_req, res) => {
        r.value = true;
        res.json({ ok: true });
      });
    });

    const response = await get("/orgs/org-1");
    expect(response.status).toBe(200);
    expect(reached.value).toBe(true);
    expect(calls.can).toEqual([{ identity, organizationId: "org-1", permission: "vehicles.read" }]);
    expect(calls.access).toEqual([]);
  });

  it("answers 403 and never runs the route when denied", async () => {
    const { engine } = fakeEngine(false);
    const { get, reached } = await serve((app, r) => {
      app.get("/orgs/:orgId", requirePermission(engine, "vehicles.read", { resolve: resolveFromParams }), (_req, res) => {
        r.value = true;
        res.json({ ok: true });
      });
    });

    const response = await get("/orgs/org-1");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(reached.value).toBe(false);
  });

  it("answers 401 without asking the engine when resolve yields no context", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get, reached } = await serve((app, r) => {
      app.get("/orgs/:orgId", requirePermission(engine, "vehicles.read", { resolve: () => null }), (_req, res) => {
        r.value = true;
        res.json({ ok: true });
      });
    });

    const response = await get("/orgs/org-1");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(reached.value).toBe(false);
    expect(calls.can).toEqual([]);
  });

  it("fails closed: an engine error goes to the error handler, never to the route", async () => {
    const { engine } = fakeEngine("throw");
    const { get, reached } = await serve((app, r) => {
      app.get("/orgs/:orgId", requirePermission(engine, "vehicles.read", { resolve: resolveFromParams }), (_req, res) => {
        r.value = true;
        res.json({ ok: true });
      });
    });

    const response = await get("/orgs/org-1");
    expect(response.status).toBe(500);
    expect(reached.value).toBe(false);
  });

  it("fails closed when resolve throws (sync or async)", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get, reached } = await serve((app, r) => {
      const route = (_req: Request, res: express.Response) => {
        r.value = true;
        res.json({ ok: true });
      };
      app.get("/sync", requirePermission(engine, "x.y", { resolve: () => { throw new Error("boom"); } }), route);
      app.get("/async", requirePermission(engine, "x.y", { resolve: async () => { throw new Error("boom"); } }), route);
    });

    expect((await get("/sync")).status).toBe(500);
    expect((await get("/async")).status).toBe(500);
    expect(reached.value).toBe(false);
    expect(calls.can).toEqual([]);
  });

  it("treats any non-true answer as a denial", async () => {
    const engine = {
      can: async () => "yes" as unknown as boolean,
      access: { check: async () => undefined as unknown as boolean },
    } satisfies AuthorizationEngine;
    const { get, reached } = await serve((app, r) => {
      app.get("/orgs/:orgId", requirePermission(engine, "x.y", { resolve: resolveFromParams }), (_req, res) => {
        r.value = true;
        res.json({ ok: true });
      });
    });

    expect((await get("/orgs/org-1")).status).toBe(403);
    expect(reached.value).toBe(false);
  });

  it("accepts a permission derived from the request", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get } = await serve((app) => {
      app.get(
        "/orgs/:orgId/:resource",
        requirePermission(engine, (req: Request) => `${String(req.params.resource)}.read`, { resolve: resolveFromParams }),
        (_req, res) => void res.json({ ok: true }),
      );
    });

    await get("/orgs/org-1/invoices");
    expect(calls.can[0]?.permission).toBe("invoices.read");
  });

  it("honors custom onDenied and onUnauthenticated responses", async () => {
    const denied = fakeEngine(false).engine;
    const { get } = await serve((app) => {
      const options = {
        resolve: (req: Request) => (req.query.anon ? null : resolveFromParams(req)),
        onDenied: (_req: Request, res: { status(c: number): { json(b: unknown): unknown } }) => void res.status(404).json({ error: "not_found" }),
        onUnauthenticated: (_req: Request, res: { status(c: number): { json(b: unknown): unknown } }) => void res.status(418).json({ error: "who" }),
      };
      app.get("/orgs/:orgId", requirePermission(denied, "x.y", options), (_req, res) => void res.json({}));
    });

    const deniedResponse = await get("/orgs/org-1");
    expect(deniedResponse.status).toBe(404);
    expect(await deniedResponse.json()).toEqual({ error: "not_found" });
    expect((await get("/orgs/org-1?anon=1")).status).toBe(418);
  });
});

describe("requireFeature / authorize", () => {
  it("requireFeature delegates to engine.access.check() with only the feature", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get } = await serve((app) => {
      app.get("/orgs/:orgId", requireFeature(engine, "ai_assistant", { resolve: resolveFromParams }), (_req, res) => void res.json({}));
    });

    expect((await get("/orgs/org-1")).status).toBe(200);
    expect(calls.access).toEqual([{ identity, organizationId: "org-1", feature: "ai_assistant" }]);
    expect(calls.can).toEqual([]);
  });

  it("authorize with permission + feature checks both through engine.access.check()", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get } = await serve((app) => {
      app.get(
        "/orgs/:orgId",
        authorize(engine, { permission: "assistant.use", feature: "ai_assistant", resolve: resolveFromParams }),
        (_req, res) => void res.json({}),
      );
    });

    await get("/orgs/org-1");
    expect(calls.access).toEqual([
      { identity, organizationId: "org-1", permission: "assistant.use", feature: "ai_assistant" },
    ]);
  });

  it("refuses to build a middleware that checks nothing", () => {
    const { engine } = fakeEngine(true);
    expect(() => authorize(engine, { resolve: () => null })).toThrow(TypeError);
  });
});

describe("with the real engine", () => {
  it("allows the Owner, and denies a stranger and another organization (deny-by-default)", async () => {
    const storage = createMemoryStorage();
    const engine = createAuthorizationEngine(storage);
    await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme",
      ownerRoleId: "role-1",
      membershipId: "m-1",
      ownerIdentity: identity,
    });

    const { get } = await serve((app) => {
      app.get(
        "/orgs/:orgId",
        requirePermission(engine, "vehicles.delete", {
          resolve: (req: Request) => ({
            identity: { provider: "supabase", subject: String(req.query.as) },
            organizationId: String(req.params.orgId),
          }),
        }),
        (_req, res) => void res.json({ ok: true }),
      );
    });

    expect((await get("/orgs/org-1?as=user-1")).status).toBe(200);
    expect((await get("/orgs/org-1?as=stranger")).status).toBe(403);
    expect((await get("/orgs/org-2?as=user-1")).status).toBe(403);
  });
});

describe("dynamic keys that resolve to nothing (audit F-01)", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a number", 42],
  ])("answers 403 and never asks the engine when the permission resolver returns %s", async (_label, value) => {
    const { engine, calls } = fakeEngine(true);
    const { get, reached } = await serve((app, r) => {
      app.get(
        "/orgs/:orgId",
        requirePermission(engine, (() => value) as unknown as () => string, { resolve: resolveFromParams }),
        (_req, res) => {
          r.value = true;
          res.json({ ok: true });
        },
      );
    });

    expect((await get("/orgs/org-1")).status).toBe(403);
    expect(reached.value).toBe(false);
    expect(calls.can).toEqual([]);
    expect(calls.access).toEqual([]);
  });

  it("also denies when a dynamic feature resolver returns undefined", async () => {
    const { engine, calls } = fakeEngine(true);
    const { get } = await serve((app) => {
      app.get(
        "/orgs/:orgId",
        requireFeature(engine, (() => undefined) as unknown as () => string, { resolve: resolveFromParams }),
        (_req, res) => void res.json({ ok: true }),
      );
    });

    expect((await get("/orgs/org-1")).status).toBe(403);
    expect(calls.access).toEqual([]);
  });

  it("does not let a real member through a route whose permission was never mapped (end to end)", async () => {
    const storage = createMemoryStorage();
    await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme",
      ownerRoleId: "r-owner",
      membershipId: "m-owner",
      ownerIdentity: { provider: "supabase", subject: "owner" },
    });
    await storage.roles.create({ id: "r-viewer", organizationId: "org-1", name: "Viewer", permissionKeys: [] });
    await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity, roleIds: ["r-viewer"] });
    const engine = createAuthorizationEngine(storage);
    const mapped: Record<string, string> = { GET: "reports.read" };

    const { get } = await serve((app) => {
      app.use(
        "/orgs/:orgId",
        requirePermission(engine, (req: Request) => mapped[req.method] as string, { resolve: resolveFromParams }),
        (_req, res) => void res.json({ ok: true }),
      );
    });
    expect((await get("/orgs/org-1")).status).toBe(403);
  });
});
