import { describe, expect, it } from "vitest";
import type { AuthorizationEngine, FeatureRepository, Identity } from "@uniora/core";
import { createCachedAuthorizationSnapshot, createCachedIdentity } from "./request-cache.js";

function createFakeEngine(grantedPermissions: Set<string>): AuthorizationEngine {
  return {
    can: async (input) => grantedPermissions.has(input.permission),
    access: { check: async () => true },
  };
}

function createFakeFeatures(enabledFeatures: Set<string>): Pick<FeatureRepository, "isEnabled"> {
  return {
    isEnabled: async (_organizationId, key) => enabledFeatures.has(key),
  };
}

const identity: Identity = { provider: "supabase", subject: "user-1" };

describe("createCachedAuthorizationSnapshot", () => {
  it("delegates to computeAuthorizationSnapshot and returns the resolved snapshot", async () => {
    const engine = createFakeEngine(new Set(["vehicles.create"]));
    const features = createFakeFeatures(new Set(["advanced_reports"]));
    const getSnapshot = createCachedAuthorizationSnapshot(engine, features);

    const snapshot = await getSnapshot({
      identity,
      organizationId: "org-1",
      permissions: ["vehicles.create", "vehicles.delete"],
      features: ["advanced_reports", "ai_assistant"],
    });

    expect(snapshot).toEqual({
      organizationId: "org-1",
      permissions: { "vehicles.create": true, "vehicles.delete": false },
      features: { advanced_reports: true, ai_assistant: false },
    });
  });

  // react.cache() only dedupes within a real React Server Components render
  // (e.g. Next.js App Router) — outside that context it is a passthrough, so
  // this only verifies the wrapped call keeps producing correct results, not
  // that it dedupes (see request-cache.ts comment / docs/next.md).
  it("keeps returning correct results across repeated calls with the same input", async () => {
    const engine = createFakeEngine(new Set(["vehicles.create"]));
    const features = createFakeFeatures(new Set());
    const getSnapshot = createCachedAuthorizationSnapshot(engine, features);

    const input = { identity, organizationId: "org-1", permissions: ["vehicles.create"] };
    const first = await getSnapshot(input);
    const second = await getSnapshot(input);

    expect(first).toEqual(second);
  });
});

describe("createCachedIdentity", () => {
  it("delegates to the wrapped resolver and returns its result", async () => {
    const getIdentity = createCachedIdentity(async () => identity);
    await expect(getIdentity()).resolves.toEqual(identity);
  });

  it("returns null when the wrapped resolver returns null", async () => {
    const getIdentity = createCachedIdentity(async () => null);
    await expect(getIdentity()).resolves.toBeNull();
  });
});
