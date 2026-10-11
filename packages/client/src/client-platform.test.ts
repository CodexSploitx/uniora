import { generateKeyPairSync, sign } from "node:crypto";
import { bootstrapPlatform, createApiCredentialService, createMemoryApiCredentialStorage, createMemoryPlatformStorage, createMemoryStorage } from "@uniora/core";
import { createUnioraServer, silentLogger } from "@uniora/server";
import type { RunningServer } from "@uniora/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUnioraClient } from "./index.js";
import type { UnioraClient } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const operatorToken = (sub: string, claims: Record<string, unknown> = { auth_time: Math.floor(Date.now() / 1000) - 20, amr: ["pwd", "mfa"] }) => {
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({ iss: "https://staff.test/", aud: "uniora", sub, exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
};

let server: RunningServer;
let uniora: UnioraClient;

beforeAll(async () => {
  const credentials = createMemoryApiCredentialStorage();
  const service = createApiCredentialService({ storage: credentials });
  const operator = { provider: "uniora-cli", subject: "t" };
  const client = await service.createClient({ actor: operator, name: "staff-panel", scopes: ["platform:admin"], organizations: "*" });
  const { token } = await service.createKey({ actor: operator, clientId: client.id });
  const platform = createMemoryPlatformStorage();
  await bootstrapPlatform({ platform, admin: { provider: "staff", subject: "root" } });
  server = await createUnioraServer({
    storage: createMemoryStorage(),
    credentials,
    logger: silentLogger,
    actorTokens: [{ provider: "staff", issuer: "https://staff.test/", audience: "uniora", algorithms: ["RS256"], jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" } as never] } }],
    platform: { storage: platform, providers: ["staff"] },
  }).listen({ port: 0 });
  uniora = createUnioraClient({ baseUrl: server.url, apiKey: token });
});
afterAll(async () => {
  await server.close(500);
});

describe("platform calls from the client", () => {
  it("speak for the operator whose own token they present", async () => {
    const roles = await uniora.platformRoles.list({}, { operatorToken: operatorToken("root") });
    expect(roles.items.map((role) => role.key)).toEqual(["platform_admin"]);
    const created = await uniora.platformRoles.create({ key: "support", name: "Support", permissions: ["platform.organizations.read"] }, { operatorToken: operatorToken("root") });
    expect(created.version).toBe(1);
    const edited = await uniora.platformRoles.update({ roleId: created.id, name: "Support desk" }, { operatorToken: operatorToken("root"), ifMatch: created.version });
    expect(edited.version).toBe(2);
  });

  it("surface the step-up requirement and the stable codes", async () => {
    await expect(uniora.platformRoles.create({ key: "x_role", name: "X", permissions: [] }, { operatorToken: operatorToken("root", {}) })).rejects.toMatchObject({ status: 428, code: "platform_step_up_required" });
    await expect(uniora.platformRoles.list({}, { operatorToken: operatorToken("stranger") })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(uniora.platformRoles.list({}, { operatorToken: "nope" })).rejects.toMatchObject({ status: 401, code: "actor_token_invalid" });
  });

  it("refuse wrong use before any request leaves", async () => {
    // @ts-expect-error a platform call must say which operator
    await expect(uniora.platformRoles.list({}, {})).rejects.toThrow(/platform operator/);
    // @ts-expect-error and has no asserted form
    await expect(uniora.platformRoles.list({}, { actor: { subject: "root" } })).rejects.toThrow();
    // @ts-expect-error other calls take no operator token
    await expect(uniora.organizations.list({}, { operatorToken: "x" })).rejects.toThrow(/not a platform call/);
  });
});
