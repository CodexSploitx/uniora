import { generateKeyPairSync, sign } from "node:crypto";
import { createApiCredentialService, createMemoryApiCredentialStorage, createMemoryStorage, createOrganizationWithOwner } from "@uniora/core";
import { createUnioraServer, silentLogger } from "@uniora/server";
import type { RunningServer } from "@uniora/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUnioraClient } from "./index.js";
import type { UnioraClient } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const userToken = (sub: string) => {
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({ iss: "https://idp.test/", aud: "uniora", sub, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
};

let server: RunningServer;
let uniora: UnioraClient;

beforeAll(async () => {
  const storage = createMemoryStorage();
  for (const permission of ["members.roles.manage", "reports.read"]) await storage.permissions.register({ key: permission });
  await createOrganizationWithOwner(storage, { organizationId: "org_acme", organizationName: "Acme", ownerRoleId: "role_owner", membershipId: "mem_owner", ownerIdentity: { provider: "main", subject: "owner" } });
  await storage.roles.create({ id: "role_viewer", organizationId: "org_acme", name: "Viewer", permissionKeys: ["reports.read"] });
  await storage.roles.create({ id: "role_manager", organizationId: "org_acme", name: "Manager", permissionKeys: ["members.roles.manage", "reports.read"] });
  await storage.memberships.create({ id: "mem_mgr", organizationId: "org_acme", identity: { provider: "main", subject: "mgr" }, roleIds: ["role_manager"] });
  await storage.memberships.create({ id: "mem_bob", organizationId: "org_acme", identity: { provider: "main", subject: "bob" } });
  const credentials = createMemoryApiCredentialStorage();
  const service = createApiCredentialService({ storage: credentials });
  const operator = { provider: "uniora-cli", subject: "t" };
  const client = await service.createClient({ actor: operator, name: "backend", scopes: ["check", "members:write", "actor:verified"], organizations: "*" });
  const { token } = await service.createKey({ actor: operator, clientId: client.id });
  server = await createUnioraServer({
    storage,
    credentials,
    defaultProvider: "main",
    logger: silentLogger,
    requireVerifiedActors: true,
    actorTokens: [{ provider: "main", issuer: "https://idp.test/", audience: "uniora", algorithms: ["RS256"], jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" } as never] } }],
  }).listen({ port: 0 });
  uniora = createUnioraClient({ baseUrl: server.url, apiKey: token });
});
afterAll(async () => {
  await server.close(500);
});

describe("verified actors from the client", () => {
  it("changes things as the user whose token it presents", async () => {
    const member = await uniora.members.assignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { token: userToken("mgr") } });
    expect(member.roleIds).toEqual(["role_viewer"]);
  });

  it("is refused for a user without the permission, and for a bad token, with the stable codes", async () => {
    await expect(uniora.members.unassignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { token: userToken("bob") } })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(uniora.members.unassignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { token: "nope" } })).rejects.toMatchObject({ status: 401, code: "actor_token_invalid" });
  });

  it("an asserted actor is refused by a server that requires verified ones", async () => {
    await expect(uniora.members.unassignRole({ organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" }, { actor: { subject: "mgr" } })).rejects.toMatchObject({ status: 403, code: "actor_token_required" });
  });

  it("decisions can carry the token, and the question must be about its user", async () => {
    const ask = { identity: { subject: "bob" }, organizationId: "org_acme", permission: "reports.read" };
    expect(await uniora.decisions.check(ask, { actorToken: userToken("bob") })).toEqual({ allowed: true });
    await expect(uniora.decisions.check(ask, { actorToken: userToken("mgr") })).rejects.toMatchObject({ code: "actor_mismatch" });
  });

  it("refuses wrong use before any request leaves", async () => {
    const input = { organizationId: "org_acme", membershipId: "mem_bob", roleId: "role_viewer" };
    // @ts-expect-error both forms at once
    await expect(uniora.members.assignRole(input, { actor: { subject: "mgr", token: userToken("mgr") } })).rejects.toThrow(/not both/);
    // @ts-expect-error neither
    await expect(uniora.members.assignRole(input, { actor: {} })).rejects.toThrow(/speaks for an end user/);
    // @ts-expect-error a route without a token takes none
    await expect(uniora.organizations.list({}, { actorToken: "x" })).rejects.toThrow(/no actor token/);
  });
});
