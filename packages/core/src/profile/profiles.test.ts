import { describe, expect, it, vi } from "vitest";
import { MAX_PROFILE_BATCH, listMembersWithProfiles, sanitizeProfile } from "../index.js";
import type { ProfileResolver } from "../index.js";
import { createMemoryStorage } from "../storage/memory.js";

async function seed(count = 3) {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org", name: "Acme" });
  for (let i = 0; i < count; i++) {
    await storage.memberships.create({ id: `m${String(i).padStart(3, "0")}`, organizationId: "org", identity: { provider: "supabase", subject: `u${i}` } });
  }
  return storage;
}

describe("listMembersWithProfiles", () => {
  it("resuelve los perfiles de toda la página en UNA llamada y los pega a cada miembro", async () => {
    const storage = await seed();
    const resolveProfiles = vi.fn(async (identities) =>
      identities.slice(0, 2).map((identity: { subject: string }) => ({
        identity,
        profile: { displayName: `Persona ${identity.subject}`, email: `${identity.subject}@x.com`, avatarUrl: "https://cdn.x.com/a.png", secret: "no" },
      })),
    );
    const rows = await listMembersWithProfiles(storage, { resolveProfiles } as ProfileResolver, { organizationId: "org", rolesPerMember: 2 });

    expect(resolveProfiles).toHaveBeenCalledTimes(1);
    expect(resolveProfiles.mock.calls[0]![0]).toHaveLength(3);
    expect(rows[0]!.profile).toEqual({ displayName: "Persona u0", email: "u0@x.com", avatarUrl: "https://cdn.x.com/a.png" });
    expect(rows[2]!.profile).toBeUndefined(); // el anfitrión no la conoce
  });

  it("sin resolver devuelve el listado tal cual", async () => {
    const storage = await seed(1);
    const rows = await listMembersWithProfiles(storage, undefined, { organizationId: "org", rolesPerMember: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.profile).toBeUndefined();
  });

  it("si el resolver falla, la pantalla de miembros sigue funcionando y se avisa", async () => {
    const storage = await seed(2);
    const onResolveError = vi.fn();
    const rows = await listMembersWithProfiles(
      storage,
      { resolveProfiles: async () => Promise.reject(new Error("auth down")) },
      { organizationId: "org", rolesPerMember: 1, onResolveError },
    );
    expect(rows).toHaveLength(2);
    expect(onResolveError).toHaveBeenCalledOnce();
  });

  it("un resolver no puede hacer que una fila muestre el perfil de otra identidad", async () => {
    const storage = await seed(1);
    const rows = await listMembersWithProfiles(
      storage,
      { resolveProfiles: async () => [{ identity: { provider: "supabase", subject: "someone-else" }, profile: { displayName: "Intruso" } }] },
      { organizationId: "org", rolesPerMember: 1 },
    );
    expect(rows[0]!.profile).toBeUndefined();
  });

  it("parte los lotes enormes en llamadas de MAX_PROFILE_BATCH", async () => {
    const storage = await seed(MAX_PROFILE_BATCH + 5);
    const resolveProfiles = vi.fn(async () => []);
    await listMembersWithProfiles(storage, { resolveProfiles }, { organizationId: "org", rolesPerMember: 0 });
    expect(resolveProfiles.mock.calls.map((call) => (call as unknown[][])[0]!.length)).toEqual([MAX_PROFILE_BATCH, 5]);
  });
});

describe("sanitizeProfile", () => {
  it("recorta, descarta campos desconocidos y solo acepta avatares http(s)", () => {
    expect(sanitizeProfile({ displayName: "  Ana  ", email: "a@x.com", avatarUrl: "javascript:alert(1)", other: 1 })).toEqual({ displayName: "Ana", email: "a@x.com" });
    expect(sanitizeProfile({ avatarUrl: "data:image/png;base64,AAA" })).toBeUndefined();
    expect(sanitizeProfile({ displayName: "x".repeat(1000) })!.displayName).toHaveLength(320);
    expect(sanitizeProfile(null)).toBeUndefined();
    expect(sanitizeProfile({ displayName: 3 })).toBeUndefined();
  });
});
