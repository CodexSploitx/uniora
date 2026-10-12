import { describe, expect, it } from "vitest";
import { resolveIdentity, resolveIdentityWithProfile, toIdentity, toProfile, toVerifiedEmail } from "./identity.js";
import type { ClerkAuthClient } from "./types.js";

describe("toIdentity", () => {
  it("mapea el claim `sub` de un token de Clerk al Identity de @uniora/core", () => {
    expect(toIdentity({ sub: "user_1" })).toEqual({ provider: "clerk", subject: "user_1" });
  });

  it("lanza si sub es un string vacío (subject inválido)", () => {
    expect(() => toIdentity({ sub: "" })).toThrow(TypeError);
  });

  it("lanza si sub no es un string (confusión de tipos, p.ej. un objeto o un número)", () => {
    // @ts-expect-error — probamos deliberadamente una forma inválida en runtime,
    // ya que TypeScript desaparece en runtime y no protege contra esto (skill §40).
    expect(() => toIdentity({ sub: 12345 })).toThrow(TypeError);
    // @ts-expect-error — ídem, un objeto en lugar de un string.
    expect(() => toIdentity({ sub: { nested: true } })).toThrow(TypeError);
  });
});

describe("resolveIdentity", () => {
  it("devuelve el Identity cuando el session token es válido", async () => {
    const verifyToken: ClerkAuthClient = async () => ({ data: { sub: "user_1" } });

    expect(await resolveIdentity(verifyToken, "valid-token")).toEqual({
      provider: "clerk",
      subject: "user_1",
    });
  });

  it("devuelve null cuando el resultado trae `errors` (token inválido/expirado)", async () => {
    const verifyToken: ClerkAuthClient = async () => ({ errors: [new Error("token expired")] });

    expect(await resolveIdentity(verifyToken, "expired-token")).toBeNull();
  });

  it("devuelve null (fail-closed) si el resultado no trae errors pero el payload es malformado", async () => {
    // Simula un ClerkAuthClient mal implementado o una versión del SDK que
    // cambió de forma: no debe convertirse nunca en un Identity utilizable.
    const verifyToken = (async () => ({ data: { sub: "" } })) as ClerkAuthClient;

    expect(await resolveIdentity(verifyToken, "any-token")).toBeNull();
  });

  it("devuelve null (fail-closed) si el cliente lanza, en vez de propagar el error", async () => {
    const verifyToken: ClerkAuthClient = async () => {
      throw new Error("network timeout talking to Clerk");
    };

    await expect(resolveIdentity(verifyToken, "any-token")).resolves.toBeNull();
  });

  it("devuelve null sin llamar al cliente cuando el session token está vacío", async () => {
    let called = false;
    const verifyToken: ClerkAuthClient = async () => {
      called = true;
      return { data: { sub: "user_1" } };
    };

    expect(await resolveIdentity(verifyToken, "")).toBeNull();
    expect(called).toBe(false);
  });
});

describe("toVerifiedEmail (audit F-13)", () => {
  it("returns the address only when the provider says it is verified", () => {
    expect(toVerifiedEmail({ sub: "a", email: "Ana@X.com", email_verified: true })).toBe("Ana@X.com");
  });

  it.each([
    ["flagged unverified", { sub: "a", email: "ana@x.com", email_verified: false }],
    ["no verification flag at all", { sub: "a", email: "ana@x.com" }],
    ["no address", { sub: "a" }],
  ])("returns null when the address is %s", (_label, input) => {
    expect(toVerifiedEmail(input)).toBeNull();
  });

  it("returns null for null/undefined and for non-string addresses", () => {
    expect(toVerifiedEmail(null)).toBeNull();
    expect(toVerifiedEmail(undefined)).toBeNull();
    expect(toVerifiedEmail({ ...({ sub: "a", email: "Ana@X.com", email_verified: true }), email: 42 as unknown as string })).toBeNull();
  });
});

describe("toProfile", () => {
  it("lee las claims del session token (name, email, picture)", () => {
    expect(toProfile({ name: "Ana Pérez", email: "ana@example.com", picture: "https://img.clerk.com/a.png" })).toEqual({
      displayName: "Ana Pérez",
      email: "ana@example.com",
      avatarUrl: "https://img.clerk.com/a.png",
    });
  });

  it("lee un User del Backend de Clerk: nombre y apellido, imageUrl y el email principal", () => {
    expect(
      toProfile({
        firstName: "Ana",
        lastName: "Pérez",
        imageUrl: "https://img.clerk.com/a.png",
        primaryEmailAddressId: "e2",
        emailAddresses: [
          { id: "e1", emailAddress: "old@example.com" },
          { id: "e2", emailAddress: "ana@example.com" },
        ],
      }),
    ).toEqual({ displayName: "Ana Pérez", email: "ana@example.com", avatarUrl: "https://img.clerk.com/a.png" });
  });

  it("devuelve {} sin datos y descarta un avatar que no sea una URL http(s)", () => {
    expect(toProfile(null)).toEqual({});
    expect(toProfile({ sub: "u" } as never)).toEqual({});
    expect(toProfile({ image_url: "data:image/png;base64,AAAA" })).toEqual({});
  });
});

describe("resolveIdentityWithProfile", () => {
  it("devuelve identidad y perfil de la misma verificación", async () => {
    const verify: ClerkAuthClient = async () => ({ data: { sub: "user_1", name: "Ana", email: "a@b.co" } });
    expect(await resolveIdentityWithProfile(verify, "tok")).toEqual({
      identity: { provider: "clerk", subject: "user_1" },
      profile: { displayName: "Ana", email: "a@b.co" },
    });
  });

  it("falla cerrado: errors, excepción o token vacío dan null", async () => {
    expect(await resolveIdentityWithProfile(async () => ({ errors: [new Error("x")] }), "tok")).toBeNull();
    expect(await resolveIdentityWithProfile(async () => { throw new Error("red"); }, "tok")).toBeNull();
    expect(await resolveIdentityWithProfile(async () => ({ data: { sub: "u" } }), "")).toBeNull();
  });
});
