import { describe, expect, it } from "vitest";
import { createAuditedStorage, createAuthorizationEngine, createMemoryStorage, createTrustedPolicyStorage } from "../index.js";

const system = { provider: "sys", subject: "import" };
const ana = { provider: "p", subject: "ana" };
const NOW = new Date("2026-10-10T12:00:00Z");

/** A small deterministic generator, so a failure can be reproduced. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function junk(next: () => number, depth = 0): unknown {
  const pick = Math.floor(next() * (depth > 2 ? 9 : 12));
  switch (pick) {
    case 0: return null;
    case 1: return undefined;
    case 2: return next() < 0.5;
    case 3: return Math.floor(next() * 1000) - 500;
    case 4: return Number.NaN;
    case 5: return Infinity;
    case 6: return "x".repeat(Math.floor(next() * 1500));
    case 7: return new Date(next() * 4e12);
    case 8: return Symbol("s");
    case 9: return Array.from({ length: Math.floor(next() * 20) }, () => junk(next, depth + 1));
    case 10: return Object.fromEntries(["authenticatedAt", "startedAt", "mfa", "assuranceLevel", "methods", "ipCountry", "deviceManaged", "__proto__", "constructor"].filter(() => next() < 0.5).map((key) => [key, junk(next, depth + 1)]));
    default: return { get ipCountry() { throw new Error("getter"); } };
  }
}

describe("phases 2 and 3: hostile input to the engine", () => {
  async function seed() {
    const storage = createMemoryStorage();
    const trusted = createTrustedPolicyStorage(createAuditedStorage(storage, { actor: system }), { actor: system, reason: "unit test" });
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.permissions.register({ key: "vault.open" });
    await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["vault.open"] });
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana, roleIds: ["staff"] });
    const defs = [
      { kind: "sensitive", effect: "require", actions: ["vault.open"], condition: { all: [{ lte: [{ ref: "session.authAgeSeconds" }, { value: 300 }] }, { eq: [{ ref: "session.mfa" }, { value: true }] }] } },
      { kind: "contextual", effect: "require", actions: ["vault.open"], context: { ipCountry: "string", deviceManaged: "boolean" }, condition: { all: [{ in: [{ ref: "context.ipCountry" }, { value: ["ES"] }] }, { eq: [{ ref: "context.deviceManaged" }, { value: true }] }] } },
    ];
    for (const [index, definition] of defs.entries()) {
      await trusted.policies.create({ id: `p${index}`, organizationId: "org-1", key: `rule-${index}`, name: `rule ${index}`, definition, createdBy: system });
      await trusted.policies.activate("org-1", `p${index}`, { actor: system });
    }
    return createAuthorizationEngine(storage, { policies: { now: () => NOW } });
  }

  it("never throws and never allows unless both policies are really satisfied (3000 random inputs)", async () => {
    const engine = await seed();
    const next = rng(20261010);
    let allowed = 0;
    for (let i = 0; i < 3000; i++) {
      // Every 50th trial is a genuinely valid pair, so the "allowed only when satisfied" check below is not vacuous.
      const valid = i % 50 === 0;
      const session = valid ? { authenticatedAt: new Date(NOW.getTime() - 60_000), mfa: true } : next() < 0.8 ? junk(next) : undefined;
      const context = valid ? { ipCountry: "ES", deviceManaged: true } : next() < 0.8 ? junk(next) : undefined;
      const result = await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vault.open", ...(session !== undefined ? { session } : {}), ...(context !== undefined ? { context } : {}) } as never);
      expect(["allow", "deny", "indeterminate"]).toContain(result.decision);
      expect(result.allowed).toBe(result.decision === "allow");
      if (result.allowed) {
        allowed++;
        const s = session as { authenticatedAt: Date; mfa: boolean };
        const c = context as { ipCountry: string; deviceManaged: boolean };
        expect(s.mfa).toBe(true);
        expect(NOW.getTime() - s.authenticatedAt.getTime()).toBeLessThanOrEqual(300_000 + 999);
        expect(c.ipCountry).toBe("ES");
        expect(c.deviceManaged).toBe(true);
      }
      if (result.stepUp) expect(result.allowed).toBe(false);
    }
    expect(allowed).toBeGreaterThanOrEqual(60);
    expect(allowed).toBeLessThan(3000);
  });

  it("the caller cannot smuggle the clock, the session or the context through other fields of the input", async () => {
    const engine = await seed();
    const result = await engine.authorize({
      identity: ana,
      organizationId: "org-1",
      permission: "vault.open",
      now: NOW,
      environment: { hour: 3 },
      "session.mfa": true,
      sessionAttributes: { mfa: true },
      resource: { type: "vault", id: "v", organizationId: "org-1", attributes: { "session.mfa": true, "context.ipCountry": "ES" } },
    } as never);
    expect(result.allowed).toBe(false);
  });

  it("a policy that merely names a country or a level in its own literals gains nothing from the resource's attributes", async () => {
    const engine = await seed();
    const result = await engine.authorize({
      identity: ana,
      organizationId: "org-1",
      permission: "vault.open",
      session: { authenticatedAt: new Date(NOW.getTime() - 10_000), mfa: false },
      context: { ipCountry: "ES", deviceManaged: true },
    });
    expect(result).toMatchObject({ allowed: false, reason: "policy_denied" });
    expect(result.stepUp).toEqual({ policyKeys: ["rule-0"] });
  });
});
