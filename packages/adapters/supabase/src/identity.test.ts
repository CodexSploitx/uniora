import { describe, expect, it } from "vitest";
import { resolveIdentity, toIdentity } from "./identity.js";
import type { SupabaseAuthClient } from "./types.js";

function fakeClient(response: SupabaseAuthClient["auth"]["getUser"]): SupabaseAuthClient {
  return { auth: { getUser: response } };
}

describe("toIdentity", () => {
  it("mapea un usuario de Supabase al Identity de @uniora/core", () => {
    expect(toIdentity({ id: "user-1" })).toEqual({ provider: "supabase", subject: "user-1" });
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
  it("devuelve el Identity cuando el access token es válido", async () => {
    const client = fakeClient(async () => ({ data: { user: { id: "user-1" } }, error: null }));

    expect(await resolveIdentity(client, "valid-token")).toEqual({
      provider: "supabase",
      subject: "user-1",
    });
  });

  it("devuelve null cuando Supabase reporta un error", async () => {
    const client = fakeClient(async () => ({ data: { user: null }, error: new Error("invalid token") }));

    expect(await resolveIdentity(client, "expired-token")).toBeNull();
  });

  it("devuelve null cuando no hay error pero tampoco usuario", async () => {
    const client = fakeClient(async () => ({ data: { user: null }, error: null }));

    expect(await resolveIdentity(client, "anonymous-token")).toBeNull();
  });

  it("devuelve null (fail-closed) si el usuario devuelto tiene un id malformado", async () => {
    // Simula un SupabaseAuthClient mal implementado o una respuesta corrupta:
    // no debe convertirse nunca en un Identity utilizable.
    const client = fakeClient(async () => ({ data: { user: { id: "" } }, error: null }));

    expect(await resolveIdentity(client, "any-token")).toBeNull();
  });

  it("devuelve null (fail-closed) si el cliente lanza, en vez de propagar el error", async () => {
    const client = fakeClient(async () => {
      throw new Error("network timeout talking to Supabase");
    });

    await expect(resolveIdentity(client, "any-token")).resolves.toBeNull();
  });

  it("devuelve null sin llamar al cliente cuando el access token está vacío", async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return { data: { user: { id: "user-1" } }, error: null };
    });

    expect(await resolveIdentity(client, "")).toBeNull();
    expect(called).toBe(false);
  });
});
