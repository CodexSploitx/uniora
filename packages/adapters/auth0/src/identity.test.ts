import { describe, expect, it } from "vitest";
import { resolveIdentity, toIdentity } from "./identity.js";
import type { Auth0VerifyTokenFn } from "./types.js";

describe("toIdentity", () => {
  it("mapea el claim `sub` de un access token de Auth0 al Identity de @uniora/core", () => {
    expect(toIdentity({ sub: "auth0|user1" })).toEqual({ provider: "auth0", subject: "auth0|user1" });
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
  it("devuelve el Identity cuando el access token es válido", async () => {
    const verifyToken: Auth0VerifyTokenFn = async () => ({ sub: "auth0|user1" });

    expect(await resolveIdentity(verifyToken, "valid-token")).toEqual({
      provider: "auth0",
      subject: "auth0|user1",
    });
  });

  it("devuelve null (fail-closed) cuando el verificador lanza (firma inválida, expirado, issuer/audience incorrectos)", async () => {
    // Este es el contrato esperado de la inmensa mayoría de verificadores JWT
    // (jose.jwtVerify, jsonwebtoken.verify): lanzan en vez de devolver un
    // resultado con error.
    const verifyToken: Auth0VerifyTokenFn = async () => {
      throw new Error("signature verification failed");
    };

    await expect(resolveIdentity(verifyToken, "expired-token")).resolves.toBeNull();
  });

  it("devuelve null (fail-closed) si el verificador resuelve un payload malformado en vez de lanzar", async () => {
    // Simula un Auth0VerifyTokenFn mal implementado: no debe convertirse
    // nunca en un Identity utilizable.
    const verifyToken = (async () => ({ sub: "" })) as Auth0VerifyTokenFn;

    expect(await resolveIdentity(verifyToken, "any-token")).toBeNull();
  });

  it("devuelve null (fail-closed) si el verificador lanza por fallo de red al resolver JWKS", async () => {
    const verifyToken: Auth0VerifyTokenFn = async () => {
      throw new Error("network timeout fetching JWKS");
    };

    await expect(resolveIdentity(verifyToken, "any-token")).resolves.toBeNull();
  });

  it("devuelve null sin llamar al verificador cuando el access token está vacío", async () => {
    let called = false;
    const verifyToken: Auth0VerifyTokenFn = async () => {
      called = true;
      return { sub: "auth0|user1" };
    };

    expect(await resolveIdentity(verifyToken, "")).toBeNull();
    expect(called).toBe(false);
  });
});
