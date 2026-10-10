import { describe, expect, it } from "vitest";
import {
  PolicyError,
  createAuditedStorage,
  createAuthorizationEngine,
  createMemoryStorage,
  createPolicyService,
  createTrustedPolicyStorage,
  environmentAt,
  evaluatePolicy,
  isValidTimezone,
  parsePolicyDefinition,
  requiredFacts,
  runPolicyCommand,
} from "../index.js";
import type { EvaluablePolicy, EvaluationFacts } from "../index.js";

const system = { provider: "sys", subject: "import" };
const ana = { provider: "p", subject: "ana" };

const businessHours = {
  kind: "contextual",
  effect: "require",
  actions: ["vehicles.delete"],
  timezone: "Europe/Madrid",
  condition: {
    all: [
      { gte: [{ ref: "environment.dayOfWeek" }, { value: 1 }] },
      { lte: [{ ref: "environment.dayOfWeek" }, { value: 5 }] },
      { gte: [{ ref: "environment.minuteOfDay" }, { value: 8 * 60 }] },
      { lt: [{ ref: "environment.minuteOfDay" }, { value: 18 * 60 }] },
    ],
  },
  denyReason: "outside_business_hours",
};

const trustedNetwork = {
  kind: "contextual",
  effect: "require",
  actions: ["vehicles.export"],
  context: { ipCountry: "string", deviceManaged: "boolean" },
  condition: { all: [{ in: [{ ref: "context.ipCountry" }, { value: ["ES", "PT"] }] }, { eq: [{ ref: "context.deviceManaged" }, { value: true }] }] },
};

const code = (input: unknown): string => {
  try {
    parsePolicyDefinition(input);
    return "ok";
  } catch (error) {
    return error instanceof PolicyError ? error.message : String(error);
  }
};

const evaluable = (key: string, definition: unknown): EvaluableEntry => {
  const parsed = parsePolicyDefinition(definition);
  return { id: key, key, revision: 1, definitionHash: parsed.hash, definition: parsed.definition, analysis: parsed.analysis };
};
type EvaluableEntry = EvaluablePolicy & { analysis: ReturnType<typeof parsePolicyDefinition>["analysis"] };
const facts = (extra: Partial<EvaluationFacts> = {}): EvaluationFacts => ({ subject: {}, features: new Map(), permissions: new Map(), ...extra });
const at = (iso: string) => new Date(iso).getTime();

describe("the clock", () => {
  it("reads the local time in the given timezone, daylight saving included", () => {
    // Saturday 10 October 2026, 14:30Z: Madrid is on summer time (UTC+2).
    expect(environmentAt(at("2026-10-10T14:30:00Z"), "Europe/Madrid")).toEqual({
      "environment.epochSeconds": at("2026-10-10T14:30:00Z") / 1000,
      "environment.year": 2026,
      "environment.month": 10,
      "environment.dayOfMonth": 10,
      "environment.dayOfWeek": 6,
      "environment.hour": 16,
      "environment.minuteOfDay": 16 * 60 + 30,
      "environment.dateNumber": 20261010,
    });
    // The same instant in winter (30 January 2027, Saturday): UTC+1.
    expect(environmentAt(at("2027-01-30T14:30:00Z"), "Europe/Madrid")).toMatchObject({ "environment.hour": 15, "environment.dayOfWeek": 6 });
    // Spring forward: 29 March 2026, 01:00Z is 03:00 in Madrid; midnight is crossed correctly.
    expect(environmentAt(at("2026-03-29T01:00:00Z"), "Europe/Madrid")).toMatchObject({ "environment.hour": 3, "environment.dayOfMonth": 29 });
    expect(environmentAt(at("2026-12-31T23:30:00Z"), "Asia/Tokyo")).toMatchObject({ "environment.dateNumber": 20270101, "environment.hour": 8, "environment.dayOfWeek": 5 });
    expect(environmentAt(at("2026-10-11T00:00:00Z"), "UTC")).toMatchObject({ "environment.dayOfWeek": 7, "environment.hour": 0 });
  });

  it("refuses what it cannot read", () => {
    expect(environmentAt(Number.NaN, "UTC")).toBeNull();
    expect(environmentAt(at("2026-10-10T00:00:00Z"), "Nowhere/Land")).toBeNull();
    for (const bad of ["+02:00", "", "Europe/", "../etc", "UTC; drop", "x".repeat(100)]) expect(isValidTimezone(bad)).toBe(false);
    expect(isValidTimezone("Europe/Madrid")).toBe(true);
    expect(isValidTimezone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidTimezone(5)).toBe(false);
  });
});

describe("contextual definitions", () => {
  it("accepts time and context policies and normalizes the default timezone away", () => {
    expect(() => parsePolicyDefinition(businessHours)).not.toThrow();
    expect(() => parsePolicyDefinition(trustedNetwork)).not.toThrow();
    const utc = parsePolicyDefinition({ ...businessHours, timezone: "UTC" });
    expect(utc.definition.timezone).toBeUndefined();
    expect(utc.definition).toEqual(parsePolicyDefinition({ ...businessHours, timezone: undefined }).definition);
    expect(parsePolicyDefinition(businessHours).analysis).toMatchObject({
      environmentRefs: ["environment.dayOfWeek", "environment.minuteOfDay"],
      contextRefs: [],
    });
    expect(parsePolicyDefinition(trustedNetwork).analysis.contextRefs).toEqual(["context.deviceManaged", "context.ipCountry"]);
  });

  it("a contextual policy must read the time or the context", () => {
    expect(code({ ...businessHours, timezone: undefined, condition: { feature: "x" } })).toMatch(/must read at least one environment/);
  });

  it("the other kinds do not read the time or the context", () => {
    expect(code({ ...businessHours, kind: "access" })).toMatch(/use a "contextual" policy/);
    expect(code({ ...trustedNetwork, kind: "feature" })).toMatch(/use a "contextual" policy/);
  });

  it("refuses unknown clock attributes, undeclared and unused signals, and a pointless or invalid timezone", () => {
    expect(code({ ...businessHours, condition: { gte: [{ ref: "environment.second" }, { value: 1 }] } })).toMatch(/unknown environment attribute/);
    expect(code({ ...trustedNetwork, condition: { eq: [{ ref: "context.deviceManaged" }, { value: true }] } })).toMatch(/"ipCountry" is declared but the condition never reads it/);
    expect(code({ ...trustedNetwork, context: { deviceManaged: "boolean" } })).toMatch(/context.ipCountry is not declared/);
    expect(code({ ...trustedNetwork, context: { deviceManaged: "boolean", ipCountry: "string", constructor: "string" } })).toMatch(/is not allowed/);
    expect(code({ ...trustedNetwork, condition: { eq: [{ ref: "context.constructor" }, { value: "x" }] }, context: { ipCountry: "string", deviceManaged: "boolean" } })).toMatch(/not declared/);
    expect(code({ ...trustedNetwork, timezone: "Europe/Madrid" })).toMatch(/timezone only matters/);
    expect(code({ ...businessHours, timezone: "+02:00" })).toMatch(/IANA timezone/);
    expect(code({ ...businessHours, timezone: 5 })).toMatch(/IANA timezone/);
    expect(code({ ...businessHours, context: { a: "object" } })).toMatch(/must have one of the types/);
    expect(code({ ...businessHours, context: { ["A b"]: "string" } })).toMatch(/must start with a lowercase letter/);
  });

  it("types are checked: a time of day cannot be compared with text", () => {
    expect(code({ ...businessHours, condition: { eq: [{ ref: "environment.hour" }, { value: "9" }] } })).toMatch(/cannot compare/);
  });
});

describe("evaluating the clock and the context", () => {
  const hours = evaluable("hours", businessHours);
  const request = { permission: "vehicles.delete" };

  it("allows inside the window and denies with the policy's reason outside it, in the policy's timezone", () => {
    // Friday 9 October 2026, 10:00 in Madrid = 08:00Z.
    expect(evaluatePolicy(hours, request, facts({ now: at("2026-10-09T08:00:00Z") }))?.result).toBe("allow");
    // 17:59 local is still inside; 18:00 is outside.
    expect(evaluatePolicy(hours, request, facts({ now: at("2026-10-09T15:59:00Z") }))?.result).toBe("allow");
    expect(evaluatePolicy(hours, request, facts({ now: at("2026-10-09T16:00:00Z") }))).toMatchObject({ result: "deny", reason: "outside_business_hours" });
    // Saturday.
    expect(evaluatePolicy(hours, request, facts({ now: at("2026-10-10T08:00:00Z") }))?.result).toBe("deny");
    // 22:30Z on Friday is already Saturday 00:30 in Madrid.
    expect(evaluatePolicy(hours, request, facts({ now: at("2026-10-09T22:30:00Z") }))?.result).toBe("deny");
  });

  it("is indeterminate (never allow) when the clock cannot be read", () => {
    expect(evaluatePolicy(hours, request, facts())).toMatchObject({ result: "indeterminate", reason: "environment_unavailable" });
    expect(evaluatePolicy(hours, request, facts({ now: Number.NaN }))).toMatchObject({ result: "indeterminate", reason: "environment_unavailable" });
  });

  it("reads declared context signals; a missing or mistyped one is indeterminate", () => {
    const network = evaluable("network", trustedNetwork);
    const exp = { permission: "vehicles.export" };
    expect(evaluatePolicy(network, exp, facts({ context: { ipCountry: "ES", deviceManaged: true } }))?.result).toBe("allow");
    expect(evaluatePolicy(network, exp, facts({ context: { ipCountry: "FR", deviceManaged: true } }))?.result).toBe("deny");
    expect(evaluatePolicy(network, exp, facts({ context: { ipCountry: "ES", deviceManaged: false } }))?.result).toBe("deny");
    expect(evaluatePolicy(network, exp, facts({ context: { ipCountry: "ES" } }))).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
    expect(evaluatePolicy(network, exp, facts())).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
    expect(evaluatePolicy(network, exp, facts({ context: { ipCountry: "ES", deviceManaged: "yes" } }))).toMatchObject({ result: "indeterminate", reason: "attribute_type_mismatch" });
    // Inherited properties are not signals.
    expect(evaluatePolicy(network, exp, facts({ context: Object.create({ ipCountry: "ES", deviceManaged: true }) as Record<string, unknown> }))?.result).toBe("indeterminate");
  });

  it("exists works on a signal, so a policy can ask whether the host supplied it", () => {
    const optional = evaluable("optional", {
      kind: "contextual",
      effect: "deny",
      actions: ["vehicles.export"],
      context: { vpn: "boolean" },
      condition: { not: { exists: "context.vpn" } },
    });
    const exp = { permission: "vehicles.export" };
    expect(evaluatePolicy(optional, exp, facts({ context: { vpn: false } }))?.result).toBe("allow");
    expect(evaluatePolicy(optional, exp, facts())?.result).toBe("deny");
  });

  it("requiredFacts asks for the clock and the named signals only when an applicable policy reads them", () => {
    const network = evaluable("network", trustedNetwork);
    expect(requiredFacts([hours, network], { permission: "vehicles.delete" })).toMatchObject({ environment: true, context: [] });
    expect(requiredFacts([hours, network], { permission: "vehicles.export" })).toMatchObject({ environment: false, context: ["deviceManaged", "ipCountry"] });
    expect(requiredFacts([hours, network], { permission: "tickets.read" })).toMatchObject({ environment: false, context: [] });
  });
});

describe("through the authorization engine", () => {
  async function seed(now?: () => Date) {
    const storage = createMemoryStorage();
    const trusted = createTrustedPolicyStorage(createAuditedStorage(storage, { actor: system }), { actor: system, reason: "unit test" });
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    for (const key of ["vehicles.delete", "vehicles.export", "policies.read"]) await storage.permissions.register({ key });
    await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["vehicles.delete", "vehicles.export", "policies.read"] });
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana, roleIds: ["staff"] });
    const engine = createAuthorizationEngine(storage, { policies: { ...(now ? { now } : {}) } });
    let n = 0;
    const live = async (key: string, definition: unknown) => {
      const id = `p${++n}`;
      await trusted.policies.create({ id, organizationId: "org-1", key, name: key, definition, createdBy: system });
      await trusted.policies.activate("org-1", id, { actor: system });
    };
    return { storage, engine, live };
  }
  const del = (engine: Awaited<ReturnType<typeof seed>>["engine"], extra: object = {}) =>
    engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.delete", ...extra });

  it("decides by the engine's clock, not by anything the caller says", async () => {
    let moment = new Date("2026-10-09T08:00:00Z");
    const { engine, live } = await seed(() => moment);
    await live("business-hours", businessHours);
    expect(await del(engine)).toMatchObject({ allowed: true, reason: "allowed", policies: [{ key: "business-hours", result: "allow" }] });
    moment = new Date("2026-10-10T08:00:00Z");
    expect(await del(engine)).toMatchObject({ allowed: false, reason: "policy_denied", policies: [{ result: "deny", reason: "outside_business_hours" }] });
    // A caller cannot bring the time: extra fields are ignored.
    expect((await del(engine, { now: new Date("2026-10-09T08:00:00Z"), environment: { hour: 9 }, context: { hour: 9 } })).allowed).toBe(false);
  });

  it("fails closed when the clock throws or returns nonsense", async () => {
    const thrower = await seed(() => {
      throw new Error("clock down");
    });
    await thrower.live("business-hours", businessHours);
    expect(await del(thrower.engine)).toMatchObject({ allowed: false, decision: "indeterminate", reason: "policy_indeterminate", policies: [{ reason: "environment_unavailable" }] });
    const invalid = await seed(() => new Date(Number.NaN));
    await invalid.live("business-hours", businessHours);
    expect((await del(invalid.engine)).decision).toBe("indeterminate");
  });

  it("uses the real clock by default", async () => {
    const { engine, live } = await seed();
    await live("always", { kind: "contextual", effect: "require", actions: ["vehicles.delete"], condition: { gte: [{ ref: "environment.year" }, { value: 2025 }] } });
    expect((await del(engine)).allowed).toBe(true);
  });

  it("passes the declared signals the host verified, and nothing else", async () => {
    const { engine, live } = await seed(() => new Date());
    await live("network", trustedNetwork);
    const ask = (context?: unknown) => engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.export", ...(context !== undefined ? { context: context as Record<string, unknown> } : {}) });
    expect((await ask({ ipCountry: "ES", deviceManaged: true })).allowed).toBe(true);
    expect((await ask({ ipCountry: "US", deviceManaged: true })).reason).toBe("policy_denied");
    expect((await ask()).reason).toBe("policy_indeterminate");
    expect((await ask({ ipCountry: "ES" })).reason).toBe("policy_indeterminate");
    // A context that is not plain data is malformed input, not a way around the policy.
    expect((await ask([])).reason).toBe("malformed_input");
    expect((await ask({ "bad name": 1 })).reason).toBe("malformed_input");
    const getter = {};
    Object.defineProperty(getter, "ipCountry", { enumerable: true, get: () => "ES" });
    expect((await ask(getter)).reason).toBe("malformed_input");
  });

  it("the audit trail records the decision but not the values of the signals", async () => {
    const storage = createMemoryStorage();
    const events: unknown[] = [];
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.permissions.register({ key: "vehicles.export" });
    await storage.roles.create({ id: "staff", organizationId: "org-1", name: "Staff", permissionKeys: ["vehicles.export"] });
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana, roleIds: ["staff"] });
    const trusted = createTrustedPolicyStorage(createAuditedStorage(storage, { actor: system }), { actor: system, reason: "unit test" });
    await trusted.policies.create({ id: "p1", organizationId: "org-1", key: "network", name: "n", definition: trustedNetwork, createdBy: system });
    await trusted.policies.activate("org-1", "p1", { actor: system });
    const engine = createAuthorizationEngine(storage, { onDecision: (event) => void events.push(event) });
    await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.export", context: { ipCountry: "ES", deviceManaged: true } });
    expect(JSON.stringify(events)).not.toContain("ES");
    expect(events).toHaveLength(1);
  });

  it("simulation can ask about another moment and other signals", async () => {
    const { storage, live } = await seed(() => new Date("2026-10-09T08:00:00Z"));
    await live("business-hours", businessHours);
    await live("network", trustedNetwork);
    const service = createPolicyService({ storage, engine: { policies: { now: () => new Date("2026-10-09T08:00:00Z") } } });
    const friday = await service.simulate({ actor: ana, organizationId: "org-1", identity: ana, permission: "vehicles.delete" });
    expect(friday.allowed).toBe(true);
    const saturday = await service.simulate({ actor: ana, organizationId: "org-1", identity: ana, permission: "vehicles.delete", at: new Date("2026-10-10T08:00:00Z") });
    expect(saturday).toMatchObject({ allowed: false, reason: "policy_denied" });
    const exported = await service.simulate({ actor: ana, organizationId: "org-1", identity: ana, permission: "vehicles.export", context: { ipCountry: "PT", deviceManaged: true } });
    expect(exported.allowed).toBe(true);
    // Through the command door the moment is an ISO instant and nothing else.
    const viaCommand = (params: object) => runPolicyCommand(service, "simulate", { actor: ana, organizationId: "org-1" }, { identity: ana, permission: "vehicles.delete", ...params }) as Promise<{ allowed: boolean }>;
    expect((await viaCommand({ at: "2026-10-10T08:00:00Z" })).allowed).toBe(false);
    await expect(viaCommand({ at: "yesterday" })).rejects.toMatchObject({ code: "policy_invalid" });
    await expect(viaCommand({ at: 5 })).rejects.toMatchObject({ code: "policy_invalid" });
  });
});
