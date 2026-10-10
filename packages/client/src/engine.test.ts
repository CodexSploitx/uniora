import { createApiCredentialService, createAuthorizationEngine, createMemoryApiCredentialStorage, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import type { AuthorizeInput } from "@uniora/core";
import { createUnioraServer, silentLogger } from "@uniora/server";
import type { RunningServer } from "@uniora/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteEngine, createUnioraClient } from "./index.js";

const storage = createMemoryStorage();
let server: RunningServer;
let key: string;
const identity = (subject: string) => ({ provider: "main", subject });

beforeAll(async () => {
  for (const permission of ["reports.read", "vehicles.delete"]) await storage.permissions.register({ key: permission });
  await storage.features.register({ key: "advanced_reports", name: "Advanced reports" });
  await createOrganizationWithOwner(storage, { organizationId: "org_acme", organizationName: "Acme", ownerRoleId: "role_owner", membershipId: "mem_owner", ownerIdentity: identity("owner") });
  await createOrganizationWithOwner(storage, { organizationId: "org_other", organizationName: "Other", ownerRoleId: "role_o2", membershipId: "mem_o2", ownerIdentity: identity("other-owner") });
  await storage.roles.create({ id: "role_viewer", organizationId: "org_acme", name: "Viewer", permissionKeys: ["reports.read"] });
  await storage.memberships.create({ id: "mem_ana", organizationId: "org_acme", identity: identity("ana"), roleIds: ["role_viewer"] });
  await storage.memberships.create({ id: "mem_bob", organizationId: "org_acme", identity: identity("bob") });
  await storage.features.enable("org_acme", "advanced_reports");
  const credentials = createMemoryApiCredentialStorage();
  const service = createApiCredentialService({ storage: credentials });
  const client = await service.createClient({ actor: { provider: "uniora-cli", subject: "t" }, name: "app", scopes: ["check"], organizations: "*" });
  key = (await service.createKey({ actor: { provider: "uniora-cli", subject: "t" }, clientId: client.id })).token;
  server = await createUnioraServer({ storage, credentials, defaultProvider: "main", logger: silentLogger }).listen({ port: 0 });
});
afterAll(async () => {
  await server.close(500);
});

describe("createRemoteEngine", () => {
  const local = () => createAuthorizationEngine(storage);
  const remote = () => createRemoteEngine(createUnioraClient({ baseUrl: server.url, apiKey: key }));

  const whoAndWhat = [
    ["ana", "org_acme", "reports.read"],
    ["ana", "org_acme", "vehicles.delete"],
    ["bob", "org_acme", "reports.read"],
    ["owner", "org_acme", "vehicles.delete"],
    ["owner", "org_other", "vehicles.delete"],
    ["stranger", "org_acme", "reports.read"],
    ["ana", "org_missing", "reports.read"],
    ["other-owner", "org_acme", "reports.read"],
  ] as const;

  it("answers can() exactly like the local engine", async () => {
    for (const [subject, organizationId, permission] of whoAndWhat) {
      const input = { identity: identity(subject), organizationId, permission };
      expect(await remote().can(input), `${subject} ${organizationId} ${permission}`).toBe(await local().can(input));
    }
  });

  it("answers access.check() exactly like the local engine, with a feature", async () => {
    for (const [subject, organizationId, permission] of whoAndWhat) {
      for (const input of [
        { identity: identity(subject), organizationId, permission, feature: "advanced_reports" },
        { identity: identity(subject), organizationId, feature: "advanced_reports" },
        { identity: identity(subject), organizationId, feature: "not_a_feature" },
      ]) {
        expect(await remote().access.check(input), JSON.stringify(input)).toBe(await local().access.check(input));
      }
    }
  });

  it("answers authorize() with the same decision, reason and revision", async () => {
    for (const [subject, organizationId, permission] of whoAndWhat) {
      const input: AuthorizeInput = { identity: identity(subject), organizationId, permission };
      const [a, b] = [await remote().authorize(input), await local().authorize(input)];
      expect({ allowed: a.allowed, decision: a.decision, reason: a.reason, policyRevision: a.policyRevision }).toEqual({ allowed: b.allowed, decision: b.decision, reason: b.reason, policyRevision: b.policyRevision });
      expect(a.organizationId).toBe(organizationId);
      expect(a.evaluatedAt).toBeInstanceOf(Date);
    }
    const cross = { identity: identity("ana"), organizationId: "org_acme", permission: "reports.read", resource: { type: "vehicle", id: "v1", organizationId: "org_other" } };
    expect((await remote().authorize(cross)).reason).toBe((await local().authorize(cross)).reason);
  });

  it("treats input the server refuses as malformed: false and a deny, never an error", async () => {
    const bad = { identity: identity("ana"), organizationId: "org_acme", permission: "x".repeat(300) };
    expect(await remote().can(bad)).toBe(false);
    expect(await local().can(bad)).toBe(false);
    expect(await remote().authorize(bad)).toMatchObject({ allowed: false, decision: "deny", reason: "malformed_input" });
  });

  it("fails closed when the server cannot be reached: authorize is indeterminate and never throws, can throws", async () => {
    const errors: unknown[] = [];
    const down = createRemoteEngine(createUnioraClient({ baseUrl: "http://127.0.0.1:9", apiKey: key, retries: 0, timeoutMs: 300 }), { onError: (error) => errors.push(error) });
    expect(await down.authorize({ identity: identity("owner"), organizationId: "org_acme", permission: "reports.read" })).toMatchObject({ allowed: false, decision: "indeterminate", reason: "evaluation_error" });
    await expect(down.can({ identity: identity("owner"), organizationId: "org_acme", permission: "reports.read" })).rejects.toThrow();
    expect(errors).toHaveLength(2);
  });

  it("fails closed when the key is refused", async () => {
    const wrong = createRemoteEngine(createUnioraClient({ baseUrl: server.url, apiKey: `${key.slice(0, -1)}${key.endsWith("a") ? "b" : "a"}`, retries: 0 }));
    expect(await wrong.authorize({ identity: identity("owner"), organizationId: "org_acme", permission: "reports.read" })).toMatchObject({ allowed: false, reason: "evaluation_error" });
    await expect(wrong.can({ identity: identity("owner"), organizationId: "org_acme", permission: "reports.read" })).rejects.toMatchObject({ status: 401 });
  });
});
