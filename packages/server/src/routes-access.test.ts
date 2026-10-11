import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BACKENDS, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});
async function start(name: BackendName, options?: Parameters<typeof startFixture>[1]) {
  const f = await startFixture(name, options);
  open.push(f);
  const { token } = await f.issue();
  const as = (actor: string) => ({
    put: (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => f.call("PUT", path, { token, actor, ...init }),
    post: (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => f.call("POST", path, { token, actor, ...init }),
    patch: (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => f.call("PATCH", path, { token, actor, ...init }),
    del: (path: string, init: { headers?: Record<string, string> } = {}) => f.call("DELETE", path, { token, actor, ...init }),
  });
  return { f, token, as };
}

const ORG = "/v1/organizations/org_acme";

describe.each(BACKENDS)("delegated access routes over %s", (backend) => {
  it("assigns and takes away a role as the end user, and the audit entry says who and through which key", async () => {
    const { f, as } = await start(backend);
    const response = await as("mgr").put(`${ORG}/members/mem_bob/roles/role_viewer`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "mem_bob", roleIds: ["role_viewer"] });
    expect(response.headers.get("etag")).toBe(`"${response.body.version}"`);

    const check = await f.call("POST", "/v1/check", { token: (await f.issue()).token, body: { identity: { subject: "bob" }, organizationId: "org_acme", permission: "reports.read" } });
    expect(check.body.allowed).toBe(true);

    const entries = await f.backend.storage.auditLogs.search({ organizationId: "org_acme", action: "membership.role_assigned" });
    expect(entries[0]).toMatchObject({ actor: { provider: "main", subject: "mgr" } });
    expect(entries[0]!.metadata?.via).toMatchObject({ apiClientId: expect.stringMatching(/^apc_/), keyId: expect.any(String), requestId: response.headers.get("request-id") });
    expect((await f.backend.storage.auditLogs.verifyIntegrity()).ok).toBe(true);

    const removed = await as("mgr").del(`${ORG}/members/mem_bob/roles/role_viewer`);
    expect(removed.body.roleIds).toEqual([]);
  });

  it("applies the anti-escalation rules to the end user, not to the key", async () => {
    const { as } = await start(backend);
    // ana holds only reports.read: no permission to manage roles at all.
    expect((await as("ana").put(`${ORG}/members/mem_bob/roles/role_viewer`)).body.code).toBe("forbidden");
    // mgr cannot change themselves, nor touch the owner, nor hand out the Owner role.
    expect((await as("mgr").put(`${ORG}/members/mem_mgr/roles/role_viewer`)).body.code).toBe("access_self_change");
    expect((await as("mgr").put(`${ORG}/members/mem_owner/roles/role_viewer`)).body.code).toBe("access_target_stronger");
    expect((await as("mgr").put(`${ORG}/members/mem_bob/roles/role_owner`)).status).toBe(403);
    // a stranger who is not a member can do nothing, and learns nothing: the plain 403.
    const stranger = await as("nobody").put(`${ORG}/members/mem_bob/roles/role_viewer`);
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe("forbidden");
  });

  it("refuses an actor with a reserved provider, a repeated header, or none at all", async () => {
    const { f, token } = await start(backend);
    const path = `${ORG}/members/mem_bob/roles/role_viewer`;
    const send = (headers: Record<string, string>) => f.call("PUT", path, { token, headers });
    expect((await send({ "uniora-actor-subject": "mgr", "uniora-actor-provider": "uniora-api" })).body.code).toBe("identity_provider_reserved");
    expect((await send({ "uniora-actor-subject": "mgr", "uniora-actor-provider": "bad label" })).status).toBe(400);
    expect((await send({})).body.code).toBe("actor_required");
    expect((await send({ "uniora-actor-subject": "%E0%A4%A" })).status).toBe(400);
    // The subject travels percent-encoded, so any id survives; an explicit provider is honoured.
    expect((await send({ "uniora-actor-subject": "mgr", "uniora-actor-provider": "other" })).body.code).toBe("forbidden");
  });

  it("refuses a repeated actor header instead of picking one", async () => {
    const { f, token } = await start(backend);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${f.server.url}${ORG}/members/mem_bob/roles/role_viewer`,
        { method: "PUT", headers: { authorization: `Bearer ${token}`, "uniora-actor-subject": ["ana", "mgr"] } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(400);
  });

  it("never lets the actor come from the body", async () => {
    const { as } = await start(backend);
    const response = await as("ana").post(`${ORG}/members/mem_bob/block`, { body: { reason: "x", actor: { provider: "main", subject: "mgr" } } });
    expect(response.status).toBe(400);
  });

  it("blocks, suspends and unblocks, refusing a stale version with 412", async () => {
    const { f, as } = await start(backend);
    const blocked = await as("mgr").post(`${ORG}/members/mem_bob/block`, { body: { reason: "left the company" } });
    expect(blocked.body).toMatchObject({ status: "blocked" });
    const stale = await as("mgr").post(`${ORG}/members/mem_bob/unblock`, { headers: { "if-match": `"${blocked.body.version - 1}"` } });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe("membership_version_conflict");
    expect((await as("mgr").post(`${ORG}/members/mem_bob/unblock`, { headers: { "if-match": `"${blocked.body.version}"` } })).body.status).toBe("active");
    expect((await as("mgr").post(`${ORG}/members/mem_bob/unblock`, { headers: { "if-match": "7" } })).status).toBe(400);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await as("mgr").post(`${ORG}/members/mem_bob/suspend`, { body: { until } })).body.status).toBe("suspended");
    expect((await as("mgr").post(`${ORG}/members/mem_bob/suspend`, { body: { until: "2001-01-01T00:00:00Z" } })).status).toBe(400);
    void f;
  });

  it("removes a member, and refuses to remove the last owner", async () => {
    const { as } = await start(backend);
    expect((await as("mgr").del(`${ORG}/members/mem_bob`)).body).toEqual({ removed: true });
    expect((await as("mgr").del(`${ORG}/members/mem_bob`)).status).toBe(404);
    expect((await as("mgr").del(`${ORG}/members/mem_owner`)).status).toBe(403);
  });

  it("creates, edits, clones, grants, revokes and deletes a role", async () => {
    const { as } = await start(backend);
    const created = await as("mgr").post(`${ORG}/roles`, { body: { name: "Support agent", permissionKeys: ["reports.read"] } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Support agent", key: "support-agent", version: 1, isOwnerRole: false });
    expect(created.headers.get("location")).toContain(`/roles/${created.body.id}/permissions`);
    const roleId = created.body.id as string;

    // The actor cannot give what they do not hold.
    expect((await as("mgr").put(`${ORG}/roles/${roleId}/permissions/vehicles.delete`)).body.code).toBe("access_escalation");
    expect((await as("mgr").put(`${ORG}/roles/${roleId}/permissions/members.block`)).status).toBe(200);
    expect((await as("mgr").del(`${ORG}/roles/${roleId}/permissions/members.block`)).status).toBe(200);

    const renamed = await as("mgr").patch(`${ORG}/roles/${roleId}`, { body: { name: "Support", description: "Answers tickets" } });
    expect(renamed.body).toMatchObject({ name: "Support", description: "Answers tickets" });
    const cleared = await as("mgr").patch(`${ORG}/roles/${roleId}`, { body: { description: null }, headers: { "if-match": `"${renamed.body.version}"` } });
    expect(cleared.body.description).toBeUndefined();
    expect((await as("mgr").patch(`${ORG}/roles/${roleId}`, { body: { name: "X" }, headers: { "if-match": `"${renamed.body.version}"` } })).status).toBe(412);

    const set = await as("mgr").put(`${ORG}/roles/${roleId}/permissions`, { body: { permissionKeys: ["reports.read", "members.block"] } });
    expect(set.status).toBe(200);
    expect(set.body.granted).toContain("members.block");

    const clone = await as("mgr").post(`${ORG}/roles/${roleId}/clone`, { body: { name: "Support copy" } });
    expect(clone.status).toBe(201);
    expect(clone.body.id).not.toBe(roleId);

    expect((await as("mgr").del(`${ORG}/roles/${roleId}?members=reject`)).body).toEqual({ deleted: true });
    expect((await as("mgr").del(`${ORG}/roles/${roleId}`)).status).toBe(404);
    expect((await as("mgr").del(`${ORG}/roles/${clone.body.id}?members=detach&reassignTo=role_viewer`)).status).toBe(400);
  });

  it("does not touch another organization's members or roles through this one", async () => {
    const { as } = await start(backend);
    expect((await as("mgr").put(`/v1/organizations/org_globex/members/mem_bob/roles/role_viewer`)).status).toBe(403);
    expect((await as("mgr").put(`${ORG}/members/mem_globex_owner/roles/role_viewer`)).status).toBe(404);
    expect((await as("mgr").put(`${ORG}/members/mem_bob/roles/role_globex_owner`)).status).toBeGreaterThanOrEqual(400);
  });

  it("is refused for a client whose allowlist does not include the organization, before the actor is even read", async () => {
    const { f } = await start(backend);
    const { token } = await f.issue({ organizations: ["org_globex"] });
    const response = await f.call("PUT", `${ORG}/members/mem_bob/roles/role_viewer`, { token, actor: "mgr" });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("organization_not_found");
  });

  it("refuses every change in read-only mode", async () => {
    const { as } = await start(backend, { readOnly: true });
    const response = await as("mgr").put(`${ORG}/members/mem_bob/roles/role_viewer`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("read_only");
  });
});
