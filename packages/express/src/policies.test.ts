import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { POLICY_PERMISSIONS, createAuthorizationEngine, createMemoryStorage, createPolicyService, createTrustedPolicyStorage, createTrustedTeamStorage } from "@uniora/core";
import { authorizeResource, policyCommand } from "./policies.js";

const admin = { provider: "p", subject: "admin" };
const juan = { provider: "p", subject: "juan" };
const ana = { provider: "p", subject: "ana" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const scope = {
  kind: "scope",
  effect: "require",
  actions: ["vehicles.update"],
  resourceType: "vehicle",
  condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] },
};

async function serve() {
  const storage = createMemoryStorage();
  const trusted = createTrustedPolicyStorage(storage, { actor: admin, reason: "route test" });
  const teams = createTrustedTeamStorage(storage, { actor: admin, reason: "route test" });
  await storage.organizations.create({ id: "org", name: "Acme" });
  for (const key of [...Object.values(POLICY_PERMISSIONS), "vehicles.update"]) await storage.permissions.register({ key });
  await storage.roles.create({ id: "admin", organizationId: "org", name: "Admin", permissionKeys: Object.values(POLICY_PERMISSIONS) });
  await storage.roles.create({ id: "staff", organizationId: "org", name: "Staff", permissionKeys: ["vehicles.update"] });
  await storage.memberships.create({ id: "m-admin", organizationId: "org", identity: admin, roleIds: ["admin"] });
  await storage.memberships.create({ id: "m-juan", organizationId: "org", identity: juan, roleIds: ["staff"] });
  await storage.memberships.create({ id: "m-ana", organizationId: "org", identity: ana, roleIds: ["staff"] });
  await teams.teams.create({ id: "bcn", organizationId: "org", name: "Barcelona" });
  await teams.teamMemberships.add({ id: "tm-ana", organizationId: "org", teamId: "bcn", membershipId: "m-ana" });
  await trusted.policies.create({ id: "p1", organizationId: "org", key: "team-scope", name: "Team scope", definition: scope, createdBy: admin });
  await trusted.policies.activate("org", "p1", { actor: admin });
  const policies = createPolicyService({ storage });
  const engine = createAuthorizationEngine(storage);
  const users: Record<string, typeof admin> = { admin, juan, ana };
  const caller = (req: { header(name: string): string | undefined }) => {
    const who = users[req.header("x-test-user") ?? ""];
    return who ? { actor: who, organizationId: "org" } : null;
  };
  const decisions: string[] = [];
  const app = express();
  app.use(express.json());
  app.post("/policies", policyCommand(policies, { command: "createPolicy", resolve: caller }));
  app.post("/policies/:policyId/activate", policyCommand(policies, { command: "activatePolicy", resolve: caller }));
  app.get("/policies", policyCommand(policies, { command: "listPolicies", resolve: caller, params: (req) => (req as { query: unknown }).query }));
  app.patch(
    "/vehicles/:id",
    authorizeResource(engine, {
      permission: "vehicles.update",
      resolve: (req: { header(name: string): string | undefined; params: { id: string } }) => {
        const who = users[req.header("x-test-user") ?? ""];
        const teamIds = req.params.id === "v-bcn" ? ["bcn"] : ["other"];
        return who && { identity: who, organizationId: "org", resource: { type: "vehicle", id: req.params.id, organizationId: "org", teamIds, attributes: {} } };
      },
      onDecision: (_req, result) => {
        decisions.push(result.reason);
      },
    }),
    (_req, res) => res.json({ ok: true }),
  );
  const server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, decisions };
}

const send = (method: string, url: string, user: string | null, body?: unknown) =>
  fetch(url, { method, headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

describe("policyCommand", () => {
  it("answers 401 without a caller", async () => {
    const { base } = await serve();
    expect((await send("POST", `${base}/policies`, null, { key: "x", name: "X", definition: scope })).status).toBe(401);
  });

  it("creates, activates and lists policies; the path wins over the body; the query feeds list", async () => {
    const { base } = await serve();
    const rule = { kind: "access", effect: "deny", actions: ["vehicles.update"], condition: { not: { exists: "subject.teamIds" } } };
    const created = await send("POST", `${base}/policies`, "admin", { key: "extra", name: "Extra", definition: rule });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(id).not.toBe("p1");
    const activated = await send("POST", `${base}/policies/${id}/activate`, "admin", { policyId: "somewhere-else" });
    expect(await activated.json()).toMatchObject({ id, status: "active" });
    const drafts = await send("GET", `${base}/policies?status=active`, "admin");
    expect(((await drafts.json()) as { id: string }[]).map((p) => p.id).sort()).toEqual(["p1", id].sort());
    // The id of a new policy is never the client's to pick.
    expect((await send("POST", `${base}/policies`, "admin", { id: "mine", key: "other", name: "Other", definition: rule })).status).toBe(400);
  });

  it("refuses a caller without the right with a generic 403, and rejects fields the client must not set", async () => {
    const { base } = await serve();
    const denied = await send("POST", `${base}/policies`, "juan", { key: "x", name: "X", definition: scope });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", message: "You are not allowed to do that." });
    expect((await send("POST", `${base}/policies`, "admin", { key: "x", name: "X", definition: scope, actor: juan })).status).toBe(400);
    expect((await send("POST", `${base}/policies`, "admin", { key: "x", name: "X", definition: { kind: "access" } })).status).toBe(400);
  });
});

describe("authorizeResource", () => {
  it("lets the request through only when the role AND the policies allow it", async () => {
    const { base, decisions } = await serve();
    expect((await send("PATCH", `${base}/vehicles/v-bcn`, "ana", {})).status).toBe(200);
    // Same role, resource from another team: the scope policy refuses.
    const refused = await send("PATCH", `${base}/vehicles/v-other`, "ana", {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden" });
    // No team at all: refused as well. No session: 401.
    expect((await send("PATCH", `${base}/vehicles/v-bcn`, "juan", {})).status).toBe(403);
    expect((await send("PATCH", `${base}/vehicles/v-bcn`, null, {})).status).toBe(401);
    expect(decisions).toEqual(["allowed", "policy_denied", "policy_denied"]);
  });

  it("passes the context the server resolved to the engine, and nothing else", async () => {
    const seen: unknown[] = [];
    const engine = { authorize: async (input: unknown) => (seen.push(input), { decision: "allow", allowed: true, reason: "allowed", policies: [] }) } as never;
    let nexted = false;
    await authorizeResource(engine, {
      permission: "x.y",
      resolve: () => ({ identity: ana, organizationId: "org", context: { ipCountry: "ES" } }),
    })({}, { status: () => ({ json: () => undefined }), json: () => undefined } as never, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(seen).toEqual([{ identity: ana, organizationId: "org", context: { ipCountry: "ES" }, permission: "x.y" }]);
  });

  it("is fail-closed: an engine error goes to next(err), never to the handler", async () => {
    const calls: string[] = [];
    const engine = { authorize: async () => { throw new Error("db down"); } } as never;
    const middleware = authorizeResource(engine, { permission: "x.y", resolve: () => ({ identity: ana, organizationId: "org" }) });
    await middleware({}, { status: () => ({ json: () => undefined }), json: () => undefined } as never, (err?: unknown) => calls.push(err instanceof Error ? err.message : "next()"));
    expect(calls).toEqual(["db down"]);
  });

  it("treats indeterminate as a refusal and a missing permission key as a refusal", async () => {
    const answered: number[] = [];
    const res = { status: (code: number) => { answered.push(code); return res; }, json: () => undefined };
    let nexted = false;
    const engine = { authorize: async () => ({ decision: "indeterminate", allowed: false, reason: "policy_indeterminate", policies: [] }) } as never;
    await authorizeResource(engine, { permission: "x.y", resolve: () => ({ identity: ana, organizationId: "org" }) })({}, res as never, () => { nexted = true; });
    await authorizeResource(engine, { permission: () => "", resolve: () => ({ identity: ana, organizationId: "org" }) })({}, res as never, () => { nexted = true; });
    expect(answered).toEqual([403, 403]);
    expect(nexted).toBe(false);
  });
});
