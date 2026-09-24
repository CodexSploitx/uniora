import { describe, expect, it } from "vitest";
import { KNOWN_PROVIDERS, matchKnownProvider } from "./provider-logos";

describe("KNOWN_PROVIDERS", () => {
  it("keys match exactly what each @uniora/* adapter's toIdentity() produces", () => {
    // packages/adapters/{supabase,clerk,auth0,better-auth}/src/identity.ts
    expect(KNOWN_PROVIDERS.map((provider) => provider.key).sort()).toEqual(
      ["auth0", "better-auth", "clerk", "supabase"].sort(),
    );
  });
});

describe("matchKnownProvider", () => {
  it("matches a known adapter's exact provider string", () => {
    expect(matchKnownProvider("supabase")?.key).toBe("supabase");
    expect(matchKnownProvider("better-auth")?.key).toBe("better-auth");
  });

  it("is lenient about casing and spacing/underscores (still informational, not a validator)", () => {
    expect(matchKnownProvider("Supabase")?.key).toBe("supabase");
    expect(matchKnownProvider("  AUTH0  ")?.key).toBe("auth0");
    expect(matchKnownProvider("Better Auth")?.key).toBe("better-auth");
    expect(matchKnownProvider("better_auth")?.key).toBe("better-auth");
    expect(matchKnownProvider("CLERK")?.key).toBe("clerk");
  });

  it("returns undefined for anything else (custom JWT, another provider, typos)", () => {
    expect(matchKnownProvider("firebase")).toBeUndefined();
    expect(matchKnownProvider("my-custom-jwt")).toBeUndefined();
    expect(matchKnownProvider("")).toBeUndefined();
    expect(matchKnownProvider("supabas")).toBeUndefined();
  });
});
