import { describe, expect, it } from "vitest";
import { resolveIdentity, toIdentity } from "./identity.js";
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
