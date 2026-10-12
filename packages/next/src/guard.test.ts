import { describe, expect, it } from "vitest";
import { createMemoryStorage, createProfileSync } from "@uniora/core";
import type { AuthorizationEngine, Identity } from "@uniora/core";
import { AuthorizationDeniedError, assertAccess, assertCan } from "./guard.js";

function createFakeEngine(options: { can?: boolean; accessCheck?: boolean }): AuthorizationEngine {
  return {
    can: async () => options.can ?? false,
    access: { check: async () => options.accessCheck ?? false },
  };
}

const identity: Identity = { provider: "supabase", subject: "user-1" };
const baseInput = { identity, organizationId: "org-1", permission: "vehicles.delete" };

describe("assertCan", () => {
  it("resolves without throwing when the permission is granted", async () => {
    const engine = createFakeEngine({ can: true });
    await expect(assertCan(engine, baseInput)).resolves.toBeUndefined();
  });

  it("throws AuthorizationDeniedError when the permission is denied", async () => {
    const engine = createFakeEngine({ can: false });
    await expect(assertCan(engine, baseInput)).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });
});

describe("assertAccess", () => {
  it("resolves without throwing when access is granted", async () => {
    const engine = createFakeEngine({ accessCheck: true });
    await expect(assertAccess(engine, { identity, organizationId: "org-1", feature: "ai_assistant" })).resolves.toBeUndefined();
  });

  it("throws AuthorizationDeniedError when access is denied", async () => {
    const engine = createFakeEngine({ accessCheck: false });
    await expect(
      assertAccess(engine, { identity, organizationId: "org-1", feature: "ai_assistant" }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });
});

describe("profile sync", () => {
  const profile = { displayName: "Ana Pérez", email: "ana@example.com" };

  it("assertCan and assertAccess store the profile of the caller before deciding, even when they then deny", async () => {
    const storage = createMemoryStorage();
    const syncProfile = createProfileSync(storage, { minIntervalMs: 0 });

    await expect(assertCan(createFakeEngine({ can: false }), baseInput, { syncProfile, profile })).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect((await storage.profiles.findMany([identity]))[0]).toMatchObject({ displayName: "Ana Pérez" });

    await storage.profiles.delete(identity);
    await assertAccess(createFakeEngine({ accessCheck: true }), { identity, organizationId: "org-1", feature: "ai_assistant" }, { syncProfile, profile });
    expect((await storage.profiles.findMany([identity]))[0]).toMatchObject({ email: "ana@example.com" });
  });

  it("does nothing without both a sync and a profile", async () => {
    const storage = createMemoryStorage();
    await assertCan(createFakeEngine({ can: true }), baseInput, { syncProfile: createProfileSync(storage) });
    await assertCan(createFakeEngine({ can: true }), baseInput, { profile });
    expect(await storage.profiles.findMany([identity])).toEqual([]);
  });
});
