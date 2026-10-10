import { describe, expect, it } from "vitest";
import {
  PolicyError,
  createAuditedStorage,
  createAuthorizationEngine,
  createMemoryStorage,
  createPolicyDecisionAuditor,
  createPolicyService,
  createTrustedPolicyStorage,
  parsePolicyDefinition,
  runPolicyCommand,
} from "../index.js";
import { readSession } from "./session.js";

const system = { provider: "sys", subject: "import" };
const ana = { provider: "p", subject: "ana" };
const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

const recentMfa = {
  kind: "sensitive",
  effect: "require",
  actions: ["payments.refund"],
  condition: { all: [{ lte: [{ ref: "session.authAgeSeconds" }, { value: 300 }] }, { eq: [{ ref: "session.mfa" }, { value: true }] }] },
  denyReason: "step_up_required",
};

const message = (input: unknown): string => {
  try {
    parsePolicyDefinition(input);
    return "ok";
  } catch (error) {
    return error instanceof PolicyError ? error.message : String(error);
  }
};

describe("sensitive definitions", () => {
  it("accepts a policy that reads how the person authenticated", () => {
    const parsed = parsePolicyDefinition(recentMfa);
    expect(parsed.analysis.sessionRefs).toEqual(["session.authAgeSeconds", "session.mfa"]);
    expect(() =>
      parsePolicyDefinition({ kind: "sensitive", effect: "deny", actions: ["keys.*"], condition: { not: { contains: [{ ref: "session.methods" }, { value: "webauthn" }] } } }),
    ).not.toThrow();
  });

  it("a sensitive policy must read the session, and no other kind may", () => {
    expect(message({ ...recentMfa, condition: { feature: "x" } })).toMatch(/must read at least one session/);
    expect(message({ ...recentMfa, kind: "access" })).toMatch(/use a "sensitive" policy/);
    expect(message({ ...recentMfa, kind: "contextual" })).toMatch(/use a "sensitive" policy/);
  });

  it("refuses unknown session attributes and type errors", () => {
    expect(message({ ...recentMfa, condition: { lte: [{ ref: "session.password" }, { value: 1 }] } })).toMatch(/unknown session attribute/);
    expect(message({ ...recentMfa, condition: { eq: [{ ref: "session.mfa" }, { value: "yes" }] } })).toMatch(/cannot compare/);
    expect(message({ ...recentMfa, condition: { eq: [{ ref: "request.ip" }, { value: "x" }] } })).toMatch(/reserved/);
  });

  it("a sensitive policy may also look at the person and the resource", () => {
    expect(() =>
      parsePolicyDefinition({
        kind: "sensitive",
        effect: "require",
        actions: ["docs.export"],
        resourceType: "document",
        attributes: { classified: "boolean" },
        condition: { any: [{ not: { eq: [{ ref: "resource.classified" }, { value: true }] } }, { gte: [{ ref: "session.assuranceLevel" }, { value: 2 }] }] },
      }),
    ).not.toThrow();
  });
});

describe("reading the session the host states", () => {
  const now = NOW.getTime();
  it("computes the ages from the engine's clock, in whole seconds", () => {
    expect(readSession({ authenticatedAt: ago(90.9), startedAt: ago(3600), mfa: true, assuranceLevel: 2, methods: ["pwd", "otp", "pwd"] }, now)).toEqual({
      "session.authAgeSeconds": 90,
      "session.ageSeconds": 3600,
      "session.mfa": true,
      "session.assuranceLevel": 2,
      "session.methods": ["pwd", "otp"],
    });
    expect(readSession({}, now)).toEqual({});
  });

  it("tolerates a little clock skew and does not believe the future", () => {
    expect(readSession({ authenticatedAt: new Date(now + 30_000) }, now)).toEqual({ "session.authAgeSeconds": 0 });
    expect(readSession({ authenticatedAt: new Date(now + 3_600_000) }, now)).toEqual({});
    expect(readSession({ authenticatedAt: ago(10) }, undefined)).toEqual({});
  });

  it("refuses everything that is not plain, typed data", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      { surprise: 1 },
      { authenticatedAt: "2026-10-10T11:59:00Z" },
      { authenticatedAt: now },
      { authenticatedAt: new Date(Number.NaN) },
      { mfa: "yes" },
      { assuranceLevel: 1.5 },
      { assuranceLevel: -1 },
      { assuranceLevel: 101 },
      { methods: "pwd" },
      { methods: [1] },
      { methods: ["bad method"] },
      { methods: Array.from({ length: 17 }, (_, i) => `m${i}`) },
      Object.create({ mfa: true }, { x: { value: 1, enumerable: true } }),
    ];
    for (const value of bad) expect(readSession(value, now), JSON.stringify(value)).toBeUndefined();
    expect(readSession({ authenticatedAt: { [Symbol.toStringTag]: "Date", getTime: () => now } }, now)).toBeUndefined();
    const getter = {};
    Object.defineProperty(getter, "mfa", { enumerable: true, get: () => true });
    expect(readSession(getter, now)).toBeUndefined();
  });
});

describe("sensitive policies through the engine", () => {
  async function seed() {
    const storage = createMemoryStorage();
    const trusted = createTrustedPolicyStorage(createAuditedStorage(storage, { actor: system }), { actor: system, reason: "unit test" });
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    for (const key of ["payments.refund", "payments.read", "policies.read"]) await storage.permissions.register({ key });
    await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["payments.refund", "payments.read", "policies.read"] });
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana, roleIds: ["staff"] });
    let n = 0;
    const live = async (key: string, definition: unknown) => {
      const id = `p${++n}`;
      await trusted.policies.create({ id, organizationId: "org-1", key, name: key, definition, createdBy: system });
      await trusted.policies.activate("org-1", id, { actor: system });
    };
    const events: unknown[] = [];
    const engine = createAuthorizationEngine(storage, { policies: { now: () => NOW }, onDecision: createPolicyDecisionAuditor(storage, { record: "all" }) });
    const ask = (session?: unknown, permission = "payments.refund") =>
      engine.authorize({ identity: ana, organizationId: "org-1", permission, ...(session !== undefined ? { session: session as never } : {}) });
    return { storage, engine, live, ask, events };
  }

  it("allows a fresh, strong authentication and asks for step-up otherwise", async () => {
    const { live, ask } = await seed();
    await live("refund-step-up", recentMfa);
    const fresh = await ask({ authenticatedAt: ago(60), mfa: true });
    expect(fresh).toMatchObject({ allowed: true, reason: "allowed", policies: [{ key: "refund-step-up", kind: "sensitive", result: "allow" }] });
    expect(fresh.stepUp).toBeUndefined();

    const stale = await ask({ authenticatedAt: ago(900), mfa: true });
    expect(stale).toMatchObject({ allowed: false, reason: "policy_denied", stepUp: { policyKeys: ["refund-step-up"] }, policies: [{ reason: "step_up_required" }] });
    const noSecondFactor = await ask({ authenticatedAt: ago(10), mfa: false });
    expect(noSecondFactor).toMatchObject({ allowed: false, stepUp: { policyKeys: ["refund-step-up"] } });
  });

  it("without a session the policy is indeterminate (and a step-up is the way out), never an allow", async () => {
    const { live, ask } = await seed();
    await live("refund-step-up", recentMfa);
    expect(await ask()).toMatchObject({ allowed: false, decision: "indeterminate", reason: "policy_indeterminate", stepUp: { policyKeys: ["refund-step-up"] }, policies: [{ reason: "session_unavailable" }] });
    expect(await ask({ mfa: true })).toMatchObject({ allowed: false, policies: [{ reason: "session_unavailable" }] });
  });

  it("only applies to the actions it names; the rest of the engine is untouched", async () => {
    const { live, ask } = await seed();
    await live("refund-step-up", recentMfa);
    expect(await ask(undefined, "payments.read")).toMatchObject({ allowed: true, policies: [] });
  });

  it("there is no step-up when something else also refuses", async () => {
    const { live, ask } = await seed();
    await live("refund-step-up", recentMfa);
    await live("no-refunds-today", { kind: "contextual", effect: "deny", actions: ["payments.refund"], condition: { eq: [{ ref: "environment.dayOfWeek" }, { value: 6 }] } }); // 10 Oct 2026 is a Saturday
    const result = await ask({ authenticatedAt: ago(900), mfa: true });
    expect(result).toMatchObject({ allowed: false, reason: "policy_denied" });
    expect(result.stepUp).toBeUndefined();
  });

  it("there is no step-up when the clock is down: re-authenticating would not fix that", async () => {
    const { storage, live } = await seed();
    await live("refund-step-up", recentMfa);
    const engine = createAuthorizationEngine(storage, { policies: { now: () => new Date(Number.NaN) } });
    const result = await engine.authorize({ identity: ana, organizationId: "org-1", permission: "payments.refund", session: { authenticatedAt: ago(10), mfa: true } });
    expect(result).toMatchObject({ allowed: false, decision: "indeterminate", policies: [{ reason: "environment_unavailable" }] });
    expect(result.stepUp).toBeUndefined();
  });

  it("a session that cannot be read is malformed input, not 'no information'", async () => {
    const { live, ask } = await seed();
    await live("refund-step-up", recentMfa);
    expect((await ask({ authenticatedAt: "2026-10-10T11:59:00Z", mfa: true })).reason).toBe("malformed_input");
    expect((await ask([])).reason).toBe("malformed_input");
    expect((await ask({ mfa: "true", authenticatedAt: ago(1) })).reason).toBe("malformed_input");
  });

  it("the audit trail names the policies and the step-up, never the values of the session", async () => {
    const { storage, live, ask } = await seed();
    await live("refund-step-up", recentMfa);
    await ask({ authenticatedAt: ago(900), mfa: true, methods: ["webauthn-secret-name"], assuranceLevel: 3 });
    const entries = await storage.auditLogs.search({ organizationId: "org-1", action: "policy.decision_denied" });
    expect(entries).toHaveLength(1);
    const metadata = JSON.stringify(entries[0]!.metadata);
    expect(metadata).toContain('"stepUp":{"policyKeys":["refund-step-up"]}');
    expect(metadata).toContain('"kind":"sensitive"');
    expect(metadata).not.toContain("webauthn-secret-name");
    expect(metadata).not.toContain("900");
  });

  it("simulation takes a session in JSON, with its moments as ISO text", async () => {
    const { storage, live } = await seed();
    await live("refund-step-up", recentMfa);
    const service = createPolicyService({ storage, engine: { policies: { now: () => NOW } } });
    const run = (session: unknown) =>
      runPolicyCommand(service, "simulate", { actor: ana, organizationId: "org-1" }, { identity: ana, permission: "payments.refund", session }) as Promise<{ allowed: boolean; stepUp?: unknown }>;
    expect((await run({ authenticatedAt: "2026-10-10T11:58:00Z", mfa: true })).allowed).toBe(true);
    expect(await run({ authenticatedAt: "2026-10-10T11:00:00Z", mfa: true })).toMatchObject({ allowed: false, stepUp: { policyKeys: ["refund-step-up"] } });
    await expect(run({ authenticatedAt: "an hour ago" })).rejects.toMatchObject({ code: "policy_invalid" });
    expect(await run({ surprise: 1 })).toMatchObject({ allowed: false });
  });
});
