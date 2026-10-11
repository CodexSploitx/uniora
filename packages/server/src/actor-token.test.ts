import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerConfigError } from "./config.js";
import { ActorTokenError, createActorTokenVerifier, resolveActorTokenProviders } from "./actor-token.js";
import type { ActorTokenProvider } from "./actor-token.js";
import { nowSeconds, signJwt, testKey } from "./test-support/jwt.js";

const ISSUER = "https://idp.example.com/";
const AUDIENCE = "uniora";
const rsa = testKey("rsa");
const ec = testKey("ec256");
const ed = testKey("ed");
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef-secret");

const claims = (extra: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: AUDIENCE, sub: "user-1", iat: nowSeconds() - 5, exp: nowSeconds() + 300, ...extra });

const provider = (extra: Partial<ActorTokenProvider> = {}): ActorTokenProvider => ({
  provider: "main",
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ["RS256"],
  jwks: { keys: [rsa.publicJwk as never] },
  ...extra,
});
const verifier = (p: ActorTokenProvider = provider(), options: Parameters<typeof createActorTokenVerifier>[1] = {}) => createActorTokenVerifier(resolveActorTokenProviders([p]), options);
const reason = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "accepted", (error: unknown) => (error instanceof ActorTokenError ? `${error.kind}:${error.reason}` : String(error)));

describe("verification", () => {
  it("accepts a good RS256 token and builds the identity with the provider's label", async () => {
    const result = await verifier().verify(signJwt(claims(), rsa.privateKey, { alg: "RS256", kid: "rsa-1" }));
    expect(result.identity).toEqual({ provider: "main", subject: "user-1" });
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts every supported family: RS, PS, ES, EdDSA and HS", async () => {
    const ps = verifier(provider({ algorithms: ["PS256"] }));
    expect((await ps.verify(signJwt(claims(), rsa.privateKey, { alg: "PS256", kid: "rsa-1" }))).identity.subject).toBe("user-1");
    const es = verifier(provider({ algorithms: ["ES256"], jwks: { keys: [ec.publicJwk as never] } }));
    expect((await es.verify(signJwt(claims(), ec.privateKey, { alg: "ES256", kid: "ec256-1" }))).identity.subject).toBe("user-1");
    const eddsa = verifier(provider({ algorithms: ["EdDSA"], jwks: { keys: [ed.publicJwk as never] } }));
    expect((await eddsa.verify(signJwt(claims(), ed.privateKey, { alg: "EdDSA", kid: "ed-1" }))).identity.subject).toBe("user-1");
    const hs = verifier({ provider: "main", issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"], secret: SECRET });
    expect((await hs.verify(signJwt(claims(), SECRET, { alg: "HS256" }))).identity.subject).toBe("user-1");
  });

  it("refuses the classic attacks", async () => {
    const v = verifier();
    // alg none, in every spelling (an unsigned token has an empty signature part; with a made-up one the algorithm itself is refused)
    expect(await reason(v.verify(`${signJwt(claims(), undefined, { alg: "none" })}QUJD`))).toBe("invalid:alg_not_supported");
    for (const alg of ["none", "None", "NONE", "nOnE"]) expect(await reason(v.verify(signJwt(claims(), undefined, { alg })))).toBe("invalid:malformed"); // no signature at all
    // HS256 signed with the PUBLIC key as the secret (algorithm confusion)
    expect(await reason(v.verify(signJwt(claims(), Buffer.from(JSON.stringify(rsa.publicJwk)), { alg: "HS256" })))).toBe("invalid:alg_not_allowed");
    // an algorithm the provider did not pin
    expect(await reason(v.verify(signJwt(claims(), rsa.privateKey, { alg: "RS512", kid: "rsa-1" })))).toBe("invalid:alg_not_allowed");
    // a key the token carries inside its own header is never used
    const attacker = testKey("rsa", "attacker");
    const forged = signJwt(claims(), attacker.privateKey, { alg: "RS256", kid: "attacker", header: { jwk: attacker.publicJwk, jku: "https://evil.example.com/jwks", x5u: "https://evil.example.com/x5" } });
    expect(await reason(v.verify(forged))).toBe("invalid:key_not_found");
    // the right kid with the wrong key
    expect(await reason(v.verify(signJwt(claims(), attacker.privateKey, { alg: "RS256", kid: "rsa-1" })))).toBe("invalid:bad_signature");
    // crit extensions we do not implement
    expect(await reason(v.verify(signJwt(claims(), rsa.privateKey, { alg: "RS256", kid: "rsa-1", header: { crit: ["exp"] } })))).toBe("invalid:crit");
  });

  it("refuses tampering with any part", async () => {
    const v = verifier();
    const token = signJwt(claims(), rsa.privateKey, { alg: "RS256", kid: "rsa-1" });
    const [h, p, s] = token.split(".") as [string, string, string];
    const other = Buffer.from(JSON.stringify(claims({ sub: "admin" }))).toString("base64url");
    expect(await reason(v.verify(`${h}.${other}.${s}`))).toBe("invalid:bad_signature");
    expect(await reason(v.verify(`${h}.${p}.${s.slice(0, -4)}AAAA`))).toBe("invalid:bad_signature");
    for (const bad of ["", "a", "a.b", "a.b.c.d", `${h}.${p}.`, `.${p}.${s}`, `${h}..${s}`, "x".repeat(9000), `${h}.${p}.${s}=`, `${h}.${p}.${s}\n`]) expect(await reason(v.verify(bad)), JSON.stringify(bad.slice(0, 20))).toMatch(/^invalid:/);
  });

  it("checks the claims: issuer, audience, expiry, not-before, issued-at, lifetime, subject", async () => {
    const v = verifier();
    const check = (extra: Record<string, unknown>, remove: string[] = []) => {
      const c: Record<string, unknown> = claims(extra);
      for (const key of remove) delete c[key];
      return reason(v.verify(signJwt(c, rsa.privateKey, { alg: "RS256", kid: "rsa-1" })));
    };
    expect(await check({ iss: "https://other.example.com/" })).toBe("invalid:unknown_issuer");
    expect(await check({ aud: "someone-else" })).toBe("invalid:audience");
    expect(await check({}, ["aud"])).toBe("invalid:audience");
    expect(await check({ aud: ["a", "b", AUDIENCE] })).toBe("accepted");
    expect(await check({ aud: [1, AUDIENCE] })).toBe("invalid:audience");
    expect(await check({ exp: nowSeconds() - 120 })).toBe("invalid:expired");
    expect(await check({}, ["exp"])).toBe("invalid:exp_missing");
    expect(await check({ exp: "9999999999" })).toBe("invalid:exp_missing");
    expect(await check({ nbf: nowSeconds() + 600 })).toBe("invalid:not_yet_valid");
    expect(await check({ iat: nowSeconds() + 600 })).toBe("invalid:iat");
    expect(await check({ iat: nowSeconds() - 10, exp: nowSeconds() + 10 * 86_400 })).toBe("invalid:lifetime");
    expect(await check({}, ["iat"])).toBe("accepted");
    expect(await check({ iat: undefined, exp: nowSeconds() + 10 * 86_400 }, ["iat"])).toBe("invalid:lifetime");
    expect(await check({ sub: 42 })).toBe("invalid:subject");
    expect(await check({ sub: "" })).toBe("invalid:subject");
    expect(await check({ sub: "a\u0000b" })).toBe("invalid:subject");
    expect(await check({ sub: "x".repeat(501) })).toBe("invalid:subject");
    expect(await check({}, ["sub"])).toBe("invalid:subject");
  });

  it("honours the clock tolerance and a custom clock", async () => {
    const fixed = new Date("2030-01-01T00:00:00Z");
    const at = Math.floor(fixed.getTime() / 1000);
    const v = verifier(provider({ clockToleranceSeconds: 10 }), { now: () => fixed });
    const token = (exp: number) => signJwt({ iss: ISSUER, aud: AUDIENCE, sub: "u", iat: at - 100, exp }, rsa.privateKey, { alg: "RS256", kid: "rsa-1" });
    expect(await reason(v.verify(token(at - 5)))).toBe("accepted");
    expect(await reason(v.verify(token(at - 10)))).toBe("invalid:expired");
  });

  it("reads another claim as the subject", async () => {
    const v = verifier(provider({ subjectClaim: "uid" }));
    const result = await v.verify(signJwt(claims({ uid: "u-9" }), rsa.privateKey, { alg: "RS256", kid: "rsa-1" }));
    expect(result.identity.subject).toBe("u-9");
  });

  it("derives session facts from auth_time, amr and acr, and only what is stated", async () => {
    const v = verifier(provider({ acrLevels: { "urn:silver": 2, "urn:gold": 3 } }));
    const authTime = nowSeconds() - 120;
    const full = await v.verify(signJwt(claims({ auth_time: authTime, amr: ["pwd", "mfa"], acr: "urn:gold" }), rsa.privateKey, { alg: "RS256", kid: "rsa-1" }));
    expect(full.session).toEqual({ authenticatedAt: new Date(authTime * 1000), methods: ["pwd", "mfa"], mfa: true, assuranceLevel: 3 });
    const single = await v.verify(signJwt(claims({ amr: ["pwd"] }), rsa.privateKey, { alg: "RS256", kid: "rsa-1" }));
    expect(single.session).toEqual({ methods: ["pwd"], mfa: false });
    const nothing = await v.verify(signJwt(claims({ amr: "mfa", acr: "unmapped", auth_time: nowSeconds() + 3600 }), rsa.privateKey, { alg: "RS256", kid: "rsa-1" }));
    expect(nothing.session).toEqual({});
  });

  it("with several keys it needs the kid; without one it only accepts an unambiguous key", async () => {
    const second = testKey("rsa", "rsa-2");
    const v = verifier(provider({ jwks: { keys: [rsa.publicJwk as never, second.publicJwk as never] } }));
    expect(await reason(v.verify(signJwt(claims(), second.privateKey, { alg: "RS256", kid: "rsa-2" })))).toBe("accepted");
    expect(await reason(v.verify(signJwt(claims(), rsa.privateKey, { alg: "RS256" })))).toBe("invalid:key_not_found");
    const single = verifier();
    expect(await reason(single.verify(signJwt(claims(), rsa.privateKey, { alg: "RS256" })))).toBe("accepted");
  });

  it("refuses a DER-encoded ECDSA signature and a signature from the wrong curve", async () => {
    const v = verifier(provider({ algorithms: ["ES256"], jwks: { keys: [ec.publicJwk as never] } }));
    const input = signJwt(claims(), ec.privateKey, { alg: "ES256", kid: "ec256-1" }).split(".").slice(0, 2).join(".");
    const der = sign("sha256", Buffer.from(input), ec.privateKey).toString("base64url");
    expect(await reason(v.verify(`${input}.${der}`))).toBe("invalid:bad_signature");
    const p384 = testKey("ec384", "ec256-1");
    expect(await reason(v.verify(signJwt(claims(), p384.privateKey, { alg: "ES256", kid: "ec256-1" })))).toBe("invalid:bad_signature");
  });
});

describe("configuration", () => {
  const bad = (p: Record<string, unknown>) => () => resolveActorTokenProviders([{ provider: "main", issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256"], jwks: { keys: [rsa.publicJwk] }, ...p }]);

  it("is refused when anything is doubtful", () => {
    expect(bad({ audience: undefined })).toThrow(ServerConfigError);
    expect(bad({ audience: "" })).toThrow(/audience/);
    expect(bad({ algorithms: undefined })).toThrow(/algorithms/);
    expect(bad({ algorithms: [] })).toThrow(/algorithms/);
    expect(bad({ algorithms: ["none"] })).toThrow(/algorithms/);
    expect(bad({ algorithms: ["RS256", "HS256"] })).toThrow(/mix/);
    expect(bad({ provider: "uniora-api" })).toThrow(/reserved/);
    expect(bad({ provider: "bad label" })).toThrow(/provider/);
    expect(bad({ issuer: "" })).toThrow(/issuer/);
    expect(bad({ extra: 1 })).toThrow(/unknown option/);
    expect(bad({ jwks: undefined })).toThrow(/exactly one/);
    expect(bad({ secret: "x".repeat(40) })).toThrow(/exactly one/);
    expect(bad({ jwksUri: "https://idp.example.com/jwks" })).toThrow(/exactly one/);
    expect(bad({ jwks: undefined, jwksUri: "http://idp.example.com/jwks" })).toThrow(/https/);
    expect(bad({ jwks: undefined, jwksUri: "https://user:pw@idp.example.com/jwks" })).toThrow(/credentials/);
    expect(bad({ jwks: undefined, secret: "x".repeat(40) })).toThrow(/public keys, never a secret/);
    expect(bad({ algorithms: ["HS256"], jwks: undefined, secret: "short" })).toThrow(/32 bytes/);
    expect(bad({ algorithms: ["HS256"] })).toThrow(/secret/);
    expect(bad({ clockToleranceSeconds: 600 })).toThrow(/clockToleranceSeconds/);
    expect(bad({ subjectClaim: "__proto__" })).toThrow(/subjectClaim/);
    expect(bad({ acrLevels: { a: 500 } })).toThrow(/acrLevels/);
  });

  it("refuses a private key and a small RSA key in the key set", () => {
    const withPrivate = { ...rsa.publicJwk, d: "AQAB" };
    expect(bad({ jwks: { keys: [withPrivate] } })).toThrow(/not a usable public key/);
    const small = testKeyBits(1024);
    expect(bad({ jwks: { keys: [small] } })).toThrow(/not a usable public key/);
  });

  it("refuses two providers with the same label or the same issuer", () => {
    const one = { provider: "main", issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256"], jwks: { keys: [rsa.publicJwk] } };
    expect(() => resolveActorTokenProviders([one, { ...one, issuer: "https://b/" }])).toThrow(/twice/);
    expect(() => resolveActorTokenProviders([one, { ...one, provider: "second" }])).toThrow(/twice/);
    expect(resolveActorTokenProviders([one, { ...one, provider: "second", issuer: "https://b/" }])).toHaveLength(2);
  });

  it("routes a token to the provider that owns its issuer, with that provider's label and keys", async () => {
    const other = testKey("ec256", "other-1");
    const v = createActorTokenVerifier(
      resolveActorTokenProviders([
        provider(),
        { provider: "second", issuer: "https://second.example.com", audience: "uniora-2", algorithms: ["ES256"], jwks: { keys: [other.publicJwk] } },
      ]),
    );
    expect((await v.verify(signJwt(claims(), rsa.privateKey, { alg: "RS256", kid: "rsa-1" }))).identity.provider).toBe("main");
    const theirs = signJwt({ iss: "https://second.example.com", aud: "uniora-2", sub: "z", exp: nowSeconds() + 60 }, other.privateKey, { alg: "ES256", kid: "other-1" });
    expect((await v.verify(theirs)).identity).toEqual({ provider: "second", subject: "z" });
    // A token of one provider signed by the keys of the other is nothing.
    expect(await reason(v.verify(signJwt(claims(), other.privateKey, { alg: "ES256", kid: "other-1" })))).toBe("invalid:alg_not_allowed");
  });
});

function testKeyBits(bits: number): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  return { ...generateKeyPairSync("rsa", { modulusLength: bits }).publicKey.export({ format: "jwk" }), kid: "small" };
}

describe("remote key sets", () => {
  let idp: Server;
  let url: string;
  let keys: unknown[] = [];
  let hits = 0;
  let mode: "ok" | "down" | "redirect" | "huge" | "html" = "ok";

  beforeAll(async () => {
    idp = createServer((req, res) => {
      hits += 1;
      if (mode === "down") return void (res.writeHead(500), res.end());
      if (mode === "redirect") return void (res.writeHead(302, { location: "http://127.0.0.1:1/x" }), res.end());
      if (mode === "huge") return void (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ keys: [], pad: "x".repeat(400_000) })));
      if (mode === "html") return void (res.writeHead(200, { "content-type": "text/html" }), res.end("<html></html>"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/jwks.json`;
  });
  afterAll(() => new Promise<void>((resolve) => idp.close(() => resolve())));

  const remote = (clock: { now: Date }, extra: Partial<ActorTokenProvider> = {}) =>
    createActorTokenVerifier(resolveActorTokenProviders([{ provider: "main", issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256"], jwksUri: url, jwksCacheSeconds: 60, ...extra }]), { now: () => clock.now });
  const token = (key = rsa, kid = "rsa-1") => signJwt(claims(), key.privateKey, { alg: "RS256", kid });

  it("fetches once, caches, and shares one fetch between concurrent requests", async () => {
    keys = [rsa.publicJwk];
    mode = "ok";
    hits = 0;
    const clock = { now: new Date() };
    const v = remote(clock);
    await Promise.all(Array.from({ length: 10 }, () => v.verify(token())));
    await v.verify(token());
    expect(hits).toBe(1);
  });

  it("refreshes when the cache is old, and when a kid is unknown (but not more than once per interval)", async () => {
    keys = [rsa.publicJwk];
    mode = "ok";
    hits = 0;
    const clock = { now: new Date() };
    const v = remote(clock);
    await v.verify(token());
    clock.now = new Date(clock.now.getTime() + 61_000);
    await v.verify(token());
    expect(hits).toBe(2);
    // The provider rotates: the new kid is unknown, so the keys are fetched again.
    const rotated = testKey("rsa", "rsa-new");
    keys = [rsa.publicJwk, rotated.publicJwk];
    clock.now = new Date(clock.now.getTime() + 31_000);
    expect(await reason(v.verify(token(rotated, "rsa-new")))).toBe("accepted");
    expect(hits).toBe(3);
    // A flood of made-up kids does not become a flood of fetches.
    for (let i = 0; i < 20; i++) expect(await reason(v.verify(token(rsa, `made-up-${i}`)))).toBe("invalid:key_not_found");
    expect(hits).toBeLessThanOrEqual(4);
  });

  it("keeps verifying with the keys it has while the provider is down, then fails as unavailable", async () => {
    keys = [rsa.publicJwk];
    mode = "ok";
    const clock = { now: new Date() };
    const v = remote(clock);
    await v.verify(token());
    mode = "down";
    clock.now = new Date(clock.now.getTime() + 120_000);
    expect(await reason(v.verify(token()))).toBe("accepted");
    clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
    expect(await reason(v.verify(token()))).toBe("unavailable:the provider's keys could not be fetched");
  });

  it("never follows a redirect, never accepts an oversized or non-JSON key set, and warns the operator", async () => {
    const warnings: string[] = [];
    for (const failure of ["redirect", "huge", "html"] as const) {
      mode = failure;
      const clock = { now: new Date() };
      const v = createActorTokenVerifier(resolveActorTokenProviders([{ provider: "main", issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256"], jwksUri: url }]), { now: () => clock.now, onWarning: (m) => void warnings.push(m) });
      expect(await reason(v.verify(token())), failure).toMatch(/^unavailable:/);
    }
    expect(warnings).toHaveLength(3);
  });
});
