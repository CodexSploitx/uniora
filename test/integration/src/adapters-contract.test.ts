import * as auth0 from "@uniora/auth0";
import * as betterAuth from "@uniora/better-auth";
import * as clerk from "@uniora/clerk";
import * as supabase from "@uniora/supabase";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Contract tests for the identity adapters. The unit tests inside each adapter use hand-written
 * stubs for the host's verifier; these ones put REAL signed JWTs (jose, RS256, a local JWKS)
 * behind the verifier the way a host app wires it, and check that the adapter stays fail-closed
 * for every way a token can be bad. No network and no provider account are needed.
 */

const ISSUER = "https://tenant.example.auth0.com/";
const AUDIENCE = "https://api.example.com";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  signingKey = good.privateKey;
  otherKey = other.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
});

async function sign(
  claims: JWTPayload,
  opts: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string | number } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(opts.key ?? signingKey);
}

// How a host app wires each adapter around a real JWT library.
const verifyAuth0: auth0.Auth0VerifyTokenFn = async (token) =>
  (await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).payload as auth0.Auth0VerifiedTokenPayload;

const verifyClerk: clerk.ClerkAuthClient = async (token) => {
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    return { data: payload as unknown as clerk.ClerkVerifiedTokenPayload };
  } catch (error) {
    return { errors: [error] };
  }
};

// The two JWT-based adapters must behave identically for the same token.
const jwtAdapters = [
  { name: "auth0", provider: "auth0", resolve: (token: string) => auth0.resolveIdentity(verifyAuth0, token) },
  { name: "clerk", provider: "clerk", resolve: (token: string) => clerk.resolveIdentity(verifyClerk, token) },
] as const;

describe.each(jwtAdapters)("$name adapter with real signed JWTs", ({ provider, resolve }) => {
  it("resolves a valid token to provider + sub", async () => {
    expect(await resolve(await sign({ sub: "user-1" }))).toEqual({ provider, subject: "user-1" });
  });

  it.each([
    ["expired", () => sign({ sub: "user-1" }, { expiresIn: -60 })],
    ["wrong audience", () => sign({ sub: "user-1" }, { audience: "https://other.example.com" })],
    ["wrong issuer", () => sign({ sub: "user-1" }, { issuer: "https://evil.example.com/" })],
    ["signed with another key", () => sign({ sub: "user-1" }, { key: otherKey })],
    ["no sub claim", () => sign({})],
    ["empty sub claim", () => sign({ sub: "" })],
    ["numeric sub claim", () => sign({ sub: 42 as unknown as string })],
  ])("returns null for a token that is %s", async (_label, make) => {
    expect(await resolve(await make())).toBeNull();
  });

  it("returns null for a tampered payload (signature no longer matches)", async () => {
    const [header, , signature] = (await sign({ sub: "user-1" })).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin", iss: ISSUER, aud: AUDIENCE, exp: 4_102_444_800 })).toString("base64url");
    expect(await resolve(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it("returns null for an unsigned (alg: none) token", async () => {
    const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "admin", iss: ISSUER, aud: AUDIENCE, exp: 4_102_444_800 })}.`;
    expect(await resolve(token)).toBeNull();
  });

  it.each(["", "garbage", "a.b.c", "Bearer abc"])("returns null for the malformed token %j", async (token) => {
    expect(await resolve(token)).toBeNull();
  });
});

describe("verified e-mail comes only from a verified token (audit F-13)", () => {
  it("auth0: only when email_verified is true", async () => {
    const verified = await verifyAuth0(await sign({ sub: "u", email: "a@x.com", email_verified: true }));
    const unverified = await verifyAuth0(await sign({ sub: "u", email: "a@x.com", email_verified: false }));
    expect(auth0.toVerifiedEmail(verified)).toBe("a@x.com");
    expect(auth0.toVerifiedEmail(unverified)).toBeNull();
  });

  it("clerk: only when email_verified is true", async () => {
    const verified = (await verifyClerk(await sign({ sub: "u", email: "a@x.com", email_verified: true }))).data;
    const unverified = (await verifyClerk(await sign({ sub: "u", email: "a@x.com" }))).data;
    expect(clerk.toVerifiedEmail(verified)).toBe("a@x.com");
    expect(clerk.toVerifiedEmail(unverified)).toBeNull();
  });
});

describe("tenant isolation across providers", () => {
  it("the same subject string under two providers is two different identities", async () => {
    const token = await sign({ sub: "shared-id" });
    const a = await auth0.resolveIdentity(verifyAuth0, token);
    const c = await clerk.resolveIdentity(verifyClerk, token);
    expect(a).not.toEqual(c);
    expect(a?.subject).toBe(c?.subject);
  });
});

describe("session-based adapters stay fail-closed", () => {
  const boom = () => {
    throw new Error("upstream down");
  };

  it("supabase: error, throwing client, missing user and malformed user all give null", async () => {
    const withUser = (user: unknown, error: unknown = null) =>
      ({ auth: { getUser: async () => ({ data: { user }, error }) } }) as unknown as supabase.SupabaseAuthClient;
    expect(await supabase.resolveIdentity(withUser({ id: "u1" }), "t")).toEqual({ provider: "supabase", subject: "u1" });
    expect(await supabase.resolveIdentity(withUser({ id: "u1" }, new Error("invalid JWT")), "t")).toBeNull();
    expect(await supabase.resolveIdentity(withUser(null), "t")).toBeNull();
    expect(await supabase.resolveIdentity(withUser({ id: 7 }), "t")).toBeNull();
    expect(await supabase.resolveIdentity({ auth: { getUser: boom } } as unknown as supabase.SupabaseAuthClient, "t")).toBeNull();
  });

  it("better-auth: no session, throwing client and malformed user all give null", async () => {
    const headers = new Headers({ cookie: "session=abc" }) as unknown as betterAuth.BetterAuthHeaders;
    const client = (value: unknown) => (async () => value) as unknown as betterAuth.BetterAuthClient;
    expect(await betterAuth.resolveIdentity(client({ user: { id: "u1" } }), headers)).toEqual({
      provider: "better-auth",
      subject: "u1",
    });
    expect(await betterAuth.resolveIdentity(client(null), headers)).toBeNull();
    expect(await betterAuth.resolveIdentity(client({ user: { id: "" } }), headers)).toBeNull();
    expect(await betterAuth.resolveIdentity(boom as unknown as betterAuth.BetterAuthClient, headers)).toBeNull();
  });
});
