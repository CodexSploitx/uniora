import { describe, expect, it } from "vitest";
import { resolveIdentity, toIdentity } from "./identity.js";
import type { BetterAuthClient, BetterAuthHeaders } from "./types.js";

function fakeHeaders(values: Record<string, string> = {}): BetterAuthHeaders {
  return { get: (name) => values[name] ?? null };
}

describe("toIdentity", () => {
  it("mapea el user.id de una sesión de Better Auth al Identity de @uniora/core", () => {
    expect(toIdentity({ id: "user_1" })).toEqual({ provider: "better-auth", subject: "user_1" });
  });

  it("lanza si user.id es un string vacío (subject inválido)", () => {
    expect(() => toIdentity({ id: "" })).toThrow(TypeError);
  });

  it("lanza si user.id no es un string (confusión de tipos, p.ej. un objeto o un número)", () => {
    // @ts-expect-error — probamos deliberadamente una forma inválida en runtime,
    // ya que TypeScript desaparece en runtime y no protege contra esto (skill §40).
    expect(() => toIdentity({ id: 12345 })).toThrow(TypeError);
    // @ts-expect-error — ídem, un objeto en lugar de un string.
    expect(() => toIdentity({ id: { nested: true } })).toThrow(TypeError);
  });
});

describe("resolveIdentity", () => {
  it("devuelve el Identity cuando existe una sesión válida", async () => {
    const getSession: BetterAuthClient = async () => ({ user: { id: "user_1" } });

    expect(await resolveIdentity(getSession, fakeHeaders())).toEqual({
      provider: "better-auth",
      subject: "user_1",
    });
  });

  it("devuelve null cuando no hay sesión (getSession resuelve null)", async () => {
    const getSession: BetterAuthClient = async () => null;

    expect(await resolveIdentity(getSession, fakeHeaders())).toBeNull();
  });

  it("devuelve null (fail-closed) si la sesión existe pero el user es malformado", async () => {
    // Simula un BetterAuthClient mal implementado o una versión del SDK que
    // cambió de forma: no debe convertirse nunca en un Identity utilizable.
    const getSession = (async () => ({ user: { id: "" } })) as BetterAuthClient;

    expect(await resolveIdentity(getSession, fakeHeaders())).toBeNull();
  });

  it("devuelve null (fail-closed) si el cliente lanza, en vez de propagar el error", async () => {
    const getSession: BetterAuthClient = async () => {
      throw new Error("database lookup failed while resolving session");
    };

    await expect(resolveIdentity(getSession, fakeHeaders())).resolves.toBeNull();
  });

  it("devuelve null sin llamar al cliente cuando headers es null/undefined", async () => {
    let called = false;
    const getSession: BetterAuthClient = async () => {
      called = true;
      return { user: { id: "user_1" } };
    };

    // @ts-expect-error — probamos deliberadamente un valor inválido en runtime.
    expect(await resolveIdentity(getSession, null)).toBeNull();
    expect(called).toBe(false);
  });

  it("devuelve null sin llamar al cliente cuando headers no tiene forma de Headers (confusión de tipos)", async () => {
    let called = false;
    const getSession: BetterAuthClient = async () => {
      called = true;
      return { user: { id: "user_1" } };
    };

    // @ts-expect-error — objeto sin `.get`, forma inválida deliberada.
    expect(await resolveIdentity(getSession, { cookie: "session=abc" })).toBeNull();
    expect(called).toBe(false);
  });
});
