import { generateKeyPairSync, sign } from "node:crypto";
import { createApiCredentialService, createMemoryApiCredentialStorage, createMemoryStorage } from "@uniora/core";
import { createUnioraServer, silentLogger } from "@uniora/server";
import type { RunningServer } from "@uniora/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnioraApiError, createUnioraClient } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const machineToken = (sub = "billing-app", claims: Record<string, unknown> = {}) => {
  const input = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({ iss: "https://idp.test/", aud: "uniora-api", sub, exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
};

let server: RunningServer;
beforeAll(async () => {
  const credentials = createMemoryApiCredentialStorage();
  await createApiCredentialService({ storage: credentials }).createClient({ actor: { provider: "uniora-cli", subject: "t" }, id: "apc_billingapp0001", name: "billing", scopes: ["organizations:read"], organizations: "*" });
  server = await createUnioraServer({
    storage: createMemoryStorage(),
    credentials,
    logger: silentLogger,
    machineTokens: [{ provider: "machines", issuer: "https://idp.test/", audience: "uniora-api", algorithms: ["RS256"], jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" } as never] }, clients: { "billing-app": "apc_billingapp0001" }, allowUnscopedTokens: true }],
  }).listen({ port: 0 });
});
afterAll(async () => {
  await server.close(500);
});

describe("access tokens from the client", () => {
  it("calls with a token, or with a function that renews it for every attempt", async () => {
    const fixed = createUnioraClient({ baseUrl: server.url, accessToken: machineToken() });
    expect(await fixed.organizations.list({})).toEqual({ items: [], nextCursor: null });
    let calls = 0;
    const renewing = createUnioraClient({ baseUrl: server.url, accessToken: async () => (calls++, machineToken()) });
    await renewing.organizations.list({});
    await renewing.organizations.list({});
    expect(calls).toBe(2);
  });

  it("surfaces the server's answer for a token it does not accept", async () => {
    const stranger = createUnioraClient({ baseUrl: server.url, accessToken: machineToken("someone-else") });
    await expect(stranger.organizations.list({})).rejects.toBeInstanceOf(UnioraApiError);
    await expect(stranger.organizations.list({})).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    const narrowed = createUnioraClient({ baseUrl: server.url, accessToken: machineToken("billing-app", { scope: "check" }) });
    await expect(narrowed.organizations.list({})).rejects.toMatchObject({ status: 403 });
  });

  it("needs exactly one credential and a token that looks like one", () => {
    const base = { baseUrl: server.url };
    // @ts-expect-error neither
    expect(() => createUnioraClient(base)).toThrow(/exactly one/);
    // @ts-expect-error both
    expect(() => createUnioraClient({ ...base, apiKey: "uniora_sk_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_cccccc", accessToken: machineToken() })).toThrow(/exactly one/);
    expect(() => createUnioraClient({ ...base, accessToken: "Bearer abc.def.ghi" })).toThrow(/without a `Bearer `/);
    expect(() => createUnioraClient({ ...base, accessToken: "has space.in.it" })).toThrow(/access token/);
    expect(() => createUnioraClient({ ...base, accessToken: 7 as never })).toThrow(/token or a function/);
  });

  it("does not retry a failure to get the token, and refuses a function that returns rubbish", async () => {
    let tried = 0;
    const broken = createUnioraClient({ baseUrl: server.url, accessToken: async () => { tried++; throw new Error("idp down"); } });
    await expect(broken.organizations.list({})).rejects.toThrow("idp down");
    expect(tried).toBe(1);
    const rubbish = createUnioraClient({ baseUrl: server.url, accessToken: () => "not a token!" });
    await expect(rubbish.organizations.list({})).rejects.toThrow(/access token/);
  });
});
