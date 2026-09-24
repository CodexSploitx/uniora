import { describe, expect, it } from "vitest";
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
