import { describe, expect, it } from "vitest";
import { createMemoryStorage, createProfileSync } from "@uniora/core";
import type { AuthorizationEngine, Identity } from "@uniora/core";
import { authorizeRoute } from "./route.js";

function createFakeEngine(accessCheck: boolean): AuthorizationEngine {
  return {
    can: async () => accessCheck,
    access: { check: async () => accessCheck },
  };
}

const identity: Identity = { provider: "supabase", subject: "user-1" };
const input = { identity, organizationId: "org-1", permission: "vehicles.delete" };

describe("authorizeRoute", () => {
  it("returns null when access is granted", async () => {
    const engine = createFakeEngine(true);
    await expect(authorizeRoute(engine, input)).resolves.toBeNull();
  });

  it("returns a 403 JSON Response with a default body when access is denied", async () => {
    const engine = createFakeEngine(false);
    const response = await authorizeRoute(engine, input);

    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toBe("application/json");
    await expect(response?.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("honors a custom status and body when access is denied", async () => {
    const engine = createFakeEngine(false);
    const response = await authorizeRoute(engine, input, { status: 401, body: { error: "unauthenticated" } });

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: "unauthenticated" });
  });
});

describe("authorizeRoute profile sync", () => {
  it("stores the profile of the caller whether the route allows or denies them", async () => {
    const storage = createMemoryStorage();
    const syncProfile = createProfileSync(storage, { minIntervalMs: 0 });
    const profile = { displayName: "Ana Pérez", avatarUrl: "https://cdn.example.com/ana.png" };

    expect((await authorizeRoute(createFakeEngine(false), input, { syncProfile, profile }))?.status).toBe(403);
    expect((await storage.profiles.findMany([identity]))[0]).toMatchObject({ displayName: "Ana Pérez", avatarUrl: "https://cdn.example.com/ana.png" });

    await storage.profiles.delete(identity);
    await expect(authorizeRoute(createFakeEngine(true), input, { syncProfile, profile })).resolves.toBeNull();
    expect(await storage.profiles.findMany([identity])).toHaveLength(1);
  });
});
