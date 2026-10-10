import { describe, expect, it } from "vitest";
import {
  MAX_EVALUATION_STEPS,
  applicability,
  combineVerdicts,
  evaluatePolicy,
  evaluatePolicySet,
  parsePolicyDefinition,
  requiredFacts,
} from "../index.js";
import type { Condition, EvaluablePolicy, EvaluationFacts, PolicyDefinition, Verdict } from "../index.js";

function policy(key: string, definition: unknown, revision = 1): EvaluablePolicy & { analysis: ReturnType<typeof parsePolicyDefinition>["analysis"] } {
  const parsed = parsePolicyDefinition(definition);
  return { id: `id-${key}`, key, revision, definitionHash: parsed.hash, definition: parsed.definition, analysis: parsed.analysis };
}

const facts = (extra: Partial<EvaluationFacts> = {}): EvaluationFacts => ({
  subject: { "subject.teamIds": ["bcn"], "subject.roleKeys": ["sales"], "subject.membershipStatus": "active", "subject.membershipId": "m1", "subject.identity": "p:ana" },
  resource: { id: "v1", teamIds: ["bcn"], attributes: { status: "open", pages: 3 } },
  features: new Map(),
  permissions: new Map(),
  ...extra,
});

const request = { permission: "vehicles.update", resourceType: "vehicle" };

const scope = policy("scope", {
  kind: "scope",
  effect: "require",
  actions: ["vehicles.*"],
  resourceType: "vehicle",
  condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] },
});
const locked = policy("locked", {
  kind: "resource",
  effect: "deny",
  actions: ["vehicles.update"],
  resourceType: "vehicle",
  attributes: { status: "string" },
  condition: { eq: [{ ref: "resource.status" }, { value: "locked" }] },
  denyReason: "vehicle_locked",
});

describe("a single policy", () => {
  it("require: allows when the condition holds, denies when it does not", () => {
    expect(evaluatePolicy(scope, request, facts())?.result).toBe("allow");
    const other = facts({ resource: { id: "v2", teamIds: ["mad"] } });
    expect(evaluatePolicy(scope, request, other)).toMatchObject({ result: "deny", reason: "policy_requirement_not_met", key: "scope", revision: 1 });
  });

  it("deny: denies when the condition holds, objects to nothing when it does not", () => {
    expect(evaluatePolicy(locked, request, facts())?.result).toBe("allow");
    const closed = facts({ resource: { id: "v1", attributes: { status: "locked" } } });
    expect(evaluatePolicy(locked, request, closed)).toMatchObject({ result: "deny", reason: "vehicle_locked" });
  });

  it("is indeterminate (never allow) when what it reads is missing, mistyped or unavailable", () => {
    expect(evaluatePolicy(locked, request, facts({ resource: { id: "v1" } }))).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
    expect(evaluatePolicy(locked, request, facts({ resource: { id: "v1", attributes: { status: 5 } } }))).toMatchObject({ result: "indeterminate", reason: "attribute_type_mismatch" });
    expect(evaluatePolicy(locked, request, facts({ resource: { id: "v1", attributes: { status: null } } }))).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
    expect(evaluatePolicy(scope, request, facts({ resource: { id: "v1" } }))).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
    expect(evaluatePolicy(scope, request, facts({ subject: {} }))).toMatchObject({ result: "indeterminate", reason: "subject_unavailable" });
    expect(evaluatePolicy(scope, request, facts({ resource: { id: "v1", teamIds: ["a", 1] as unknown as string[] } }))).toMatchObject({ result: "indeterminate", reason: "attribute_type_mismatch" });
    expect(evaluatePolicy(scope, request, facts({ subject: { "subject.teamIds": "bcn" as unknown as string[] } }))).toMatchObject({ result: "indeterminate", reason: "attribute_type_mismatch" });
    expect(evaluatePolicy(locked, request, facts({ resource: undefined }))).toMatchObject({ result: "indeterminate", reason: "resource_missing" });
  });

  it("does not inherit a value from the prototype chain", () => {
    const resource = { id: "v1", attributes: Object.create({ status: "locked" }) as Record<string, unknown> };
    expect(evaluatePolicy(locked, request, facts({ resource }))).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
  });

  it("an empty team list is a fact (nobody in common), an absent one is unknown", () => {
    expect(evaluatePolicy(scope, request, facts({ resource: { id: "v1", teamIds: [] } }))?.result).toBe("deny");
    expect(evaluatePolicy(scope, request, facts({ resource: { id: "v1" } }))?.result).toBe("indeterminate");
    expect(evaluatePolicy(scope, request, facts({ subject: { "subject.teamIds": [] } }))?.result).toBe("deny");
  });

  it("applies only to its actions and its type of resource", () => {
    expect(applicability(locked.definition, { permission: "vehicles.read", resourceType: "vehicle" })).toBe("no");
    expect(applicability(locked.definition, { permission: "vehicles.update", resourceType: "ticket" })).toBe("no");
    expect(applicability(locked.definition, { permission: "vehicles.update" })).toBe("unknown");
    expect(evaluatePolicy(locked, { permission: "vehicles.read", resourceType: "vehicle" }, facts())).toBeNull();
    expect(evaluatePolicy(locked, { permission: "vehicles.update" }, facts())).toMatchObject({ result: "indeterminate", reason: "resource_missing" });
  });

  it("asks the facts it was given about features and permissions, and an unresolved one is unknown", () => {
    const needsFeature = policy("f", { kind: "feature", effect: "require", actions: ["reports.run"], condition: { feature: "advanced_reports" } });
    const request2 = { permission: "reports.run" };
    expect(evaluatePolicy(needsFeature, request2, facts({ features: new Map([["advanced_reports", true]]) }))?.result).toBe("allow");
    expect(evaluatePolicy(needsFeature, request2, facts({ features: new Map([["advanced_reports", false]]) }))?.result).toBe("deny");
    expect(evaluatePolicy(needsFeature, request2, facts({ features: new Map([["advanced_reports", "unknown"]]) }))).toMatchObject({ result: "indeterminate", reason: "feature_unavailable" });
    expect(evaluatePolicy(needsFeature, request2, facts()) ).toMatchObject({ result: "indeterminate", reason: "feature_unavailable" });

    const override = policy("o", {
      kind: "resource",
      effect: "deny",
      actions: ["vehicles.update"],
      resourceType: "vehicle",
      attributes: { status: "string" },
      condition: { all: [{ eq: [{ ref: "resource.status" }, { value: "locked" }] }, { not: { permission: "vehicles.override" } }] },
    });
    const closed = { id: "v", attributes: { status: "locked" } };
    expect(evaluatePolicy(override, request, facts({ resource: closed, permissions: new Map([["vehicles.override", false]]) }))?.result).toBe("deny");
    expect(evaluatePolicy(override, request, facts({ resource: closed, permissions: new Map([["vehicles.override", true]]) }))?.result).toBe("allow");
    expect(evaluatePolicy(override, request, facts({ resource: closed, permissions: new Map([["vehicles.override", "unknown"]]) }))?.result).toBe("indeterminate");
  });
});

describe("Kleene logic: unknown is never true", () => {
  const T: Condition = { exists: "subject.teamIds" };
  const F: Condition = { not: { exists: "subject.teamIds" } };
  const U: Condition = { feature: "nothing_known" };
  const run = (condition: Condition): Verdict => {
    const p = policy("k", { kind: "access", effect: "require", actions: ["a.b"], condition });
    return evaluatePolicy(p, { permission: "a.b" }, facts())!.result;
  };
  // `require` maps true → allow, false → deny, unknown → indeterminate.
  it("all", () => {
    expect(run({ all: [T, T] })).toBe("allow");
    expect(run({ all: [T, F] })).toBe("deny");
    expect(run({ all: [T, U] })).toBe("indeterminate");
    expect(run({ all: [F, U] })).toBe("deny");
    expect(run({ all: [U, F] })).toBe("deny");
  });
  it("any", () => {
    expect(run({ any: [F, F] })).toBe("deny");
    expect(run({ any: [F, T] })).toBe("allow");
    expect(run({ any: [F, U] })).toBe("indeterminate");
    expect(run({ any: [T, U] })).toBe("allow");
    expect(run({ any: [U, T] })).toBe("allow");
  });
  it("not", () => {
    expect(run({ not: T })).toBe("deny");
    expect(run({ not: F })).toBe("allow");
    expect(run({ not: U })).toBe("indeterminate");
    expect(run({ not: { not: U } })).toBe("indeterminate");
  });
});

describe("precedence", () => {
  it("deny overrides indeterminate overrides allow, and nothing else counts", () => {
    expect(combineVerdicts([])).toBe("allow");
    expect(combineVerdicts(["allow", "allow"])).toBe("allow");
    expect(combineVerdicts(["allow", "indeterminate"])).toBe("indeterminate");
    expect(combineVerdicts(["allow", "indeterminate", "deny"])).toBe("deny");
    expect(combineVerdicts(["deny", "allow", "allow", "allow"])).toBe("deny");
  });

  it("is the same for every order of the policies", () => {
    const closed = facts({ resource: { id: "v1", teamIds: ["bcn"], attributes: { status: "locked" } } });
    const all = [scope, locked, policy("zzz", { kind: "access", effect: "require", actions: ["*"], condition: { exists: "subject.teamIds" } })];
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const results = permutations.map((order) => evaluatePolicySet(order.map((i) => all[i]!), request, closed));
    for (const result of results) {
      expect(result.decision).toBe("deny");
      expect(result.outcomes.map((o) => o.key)).toEqual(["locked", "scope", "zzz"]);
    }
  });

  it("explains every applicable policy, not only the one that decided", () => {
    const evaluation = evaluatePolicySet([scope, locked], request, facts({ resource: { id: "v1", teamIds: ["mad"], attributes: { status: "locked" } } }));
    expect(evaluation).toMatchObject({ decision: "deny", reason: "policy_denied" });
    expect(evaluation.outcomes.map((o) => [o.key, o.result, o.reason])).toEqual([
      ["locked", "deny", "vehicle_locked"],
      ["scope", "deny", "policy_requirement_not_met"],
    ]);
  });

  it("an indeterminate policy blocks even when the others allow", () => {
    const evaluation = evaluatePolicySet([scope, locked], request, facts({ resource: { id: "v1", teamIds: ["bcn"] } }));
    expect(evaluation.decision).toBe("indeterminate");
    expect(evaluation.reason).toBe("policy_indeterminate");
  });

  it("no applicable policy is no objection, unless the caller asks for a policy to apply", () => {
    expect(evaluatePolicySet([], request, facts()).decision).toBe("allow");
    expect(evaluatePolicySet([locked], { permission: "tickets.read" }, facts()).decision).toBe("allow");
    expect(evaluatePolicySet([], request, facts(), { requireApplicablePolicy: true })).toMatchObject({ decision: "deny", reason: "no_applicable_policy" });
    expect(evaluatePolicySet([scope], request, facts(), { requireApplicablePolicy: true }).decision).toBe("allow");
  });

  it("never looks at the policy administration permissions", () => {
    const everything = policy("deny-all", { kind: "access", effect: "deny", actions: ["*"], condition: { exists: "subject.teamIds" } });
    expect(evaluatePolicySet([everything], { permission: "vehicles.update" }, facts()).decision).toBe("deny");
    expect(evaluatePolicySet([everything], { permission: "policies.manage" }, facts()).decision).toBe("allow");
  });

  it("a budget that runs out makes the rest indeterminate, never allow", () => {
    const evaluation = evaluatePolicySet([scope, locked], request, facts(), { maxSteps: 1 });
    expect(evaluation.outcomes.some((o) => o.reason === "budget_exceeded")).toBe(true);
    expect(evaluation.decision).not.toBe("allow");
    expect(MAX_EVALUATION_STEPS).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Generated checks of the properties that matter: the result does not depend on order, adding a policy never makes the
// answer more permissive, and a decision of "allow" is only ever reached when the condition really is true.
// ---------------------------------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const ATTRS = { status: "string", pages: "number", tags: "string[]", held: "boolean" } as const;

function randomLeaf(next: () => number): Condition {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  switch (Math.floor(next() * 8)) {
    case 0:
      return { eq: [{ ref: "resource.status" }, { value: pick(["open", "locked", "x"]) }] };
    case 1:
      return { gt: [{ ref: "resource.pages" }, { value: pick([1, 3, 5]) }] };
    case 2:
      return { contains: [{ ref: "resource.tags" }, { value: pick(["a", "b"]) }] };
    case 3:
      return { eq: [{ ref: "resource.held" }, { value: next() < 0.5 }] };
    case 4:
      return { intersects: [{ ref: "subject.teamIds" }, { value: ["bcn", "mad"] }] };
    case 5:
      return { exists: "resource.status" };
    case 6:
      return { feature: pick(["f_one", "f_two"]) };
    default:
      return { in: [{ ref: "resource.status" }, { value: ["open", "locked"] }] };
  }
}

function randomCondition(next: () => number, depth = 0): Condition {
  const roll = next();
  if (depth >= 3 || roll < 0.4) return randomLeaf(next);
  if (roll < 0.55) return { not: randomCondition(next, depth + 1) };
  const children = Array.from({ length: 1 + Math.floor(next() * 3) }, () => randomCondition(next, depth + 1));
  return roll < 0.8 ? { all: children } : { any: children };
}

function randomFacts(next: () => number): EvaluationFacts {
  const attributes: Record<string, unknown> = {};
  if (next() < 0.8) attributes.status = next() < 0.9 ? (next() < 0.5 ? "open" : "locked") : 7;
  if (next() < 0.8) attributes.pages = Math.floor(next() * 7);
  if (next() < 0.8) attributes.tags = next() < 0.5 ? ["a"] : ["b", "c"];
  if (next() < 0.8) attributes.held = next() < 0.5;
  return {
    subject: next() < 0.9 ? { "subject.teamIds": next() < 0.5 ? ["bcn"] : [] } : {},
    resource: next() < 0.95 ? { id: "r", attributes } : undefined,
    features: new Map([
      ["f_one", next() < 0.3 ? "unknown" : next() < 0.5],
      ["f_two", next() < 0.5],
    ]),
    permissions: new Map(),
  };
}

const restrictiveness: Record<Verdict, number> = { allow: 0, indeterminate: 1, deny: 2 };

describe("properties over generated policies and facts", () => {
  const cases = Array.from({ length: 400 }, (_, seed) => seed + 1);

  it("generates mostly valid policies (so the properties below mean something)", () => {
    const next = rng(42);
    const valid = Array.from({ length: 200 }, (_, i) => safePolicy(next, i)).filter((p) => p !== null).length;
    expect(valid).toBeGreaterThan(180);
  });

  it("the decision does not depend on the order of the policies", () => {
    for (const seed of cases) {
      const next = rng(seed);
      const policies = Array.from({ length: 2 + Math.floor(next() * 4) }, (_, i) => safePolicy(next, i)).filter((p) => p !== null);
      const f = randomFacts(next);
      const forward = evaluatePolicySet(policies, request, f);
      const reversed = evaluatePolicySet([...policies].reverse(), request, f);
      expect(reversed.decision).toBe(forward.decision);
      expect(reversed.outcomes).toEqual(forward.outcomes);
    }
  });

  it("adding a policy never makes the answer more permissive", () => {
    for (const seed of cases) {
      const next = rng(seed * 7919);
      const policies = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => safePolicy(next, i)).filter((p) => p !== null);
      let extra = safePolicy(next, 99);
      while (extra === null) extra = safePolicy(next, 99);
      const f = randomFacts(next);
      const before = evaluatePolicySet(policies, request, f).decision;
      const after = evaluatePolicySet([...policies, extra], request, f).decision;
      expect(restrictiveness[after]).toBeGreaterThanOrEqual(restrictiveness[before]);
    }
  });

  it("agrees with plain two-valued logic whenever every fact is known", () => {
    for (const seed of cases) {
      const next = rng(seed * 104729);
      const condition = randomCondition(next);
      const known: EvaluationFacts = {
        subject: { "subject.teamIds": next() < 0.5 ? ["bcn"] : ["zzz"] },
        resource: { id: "r", attributes: { status: next() < 0.5 ? "open" : "locked", pages: Math.floor(next() * 7), tags: next() < 0.5 ? ["a"] : ["b"], held: next() < 0.5 } },
        features: new Map([["f_one", next() < 0.5], ["f_two", next() < 0.5]]),
        permissions: new Map(),
      };
      const expected = reference(condition, known);
      for (const effect of ["require", "deny"] as const) {
        const p = policy("g", { kind: "resource", effect, actions: ["vehicles.update"], resourceType: "vehicle", attributes: ATTRS, condition: ensureUses(condition) });
        const result = evaluatePolicy(p, request, known)!.result;
        const wanted: Verdict = effect === "require" ? (expected ? "allow" : "deny") : expected ? "deny" : "allow";
        expect(result).toBe(wanted);
      }
    }
  });
});

/** A condition has to read every declared attribute for the definition to be valid; add harmless reads. */
function ensureUses(condition: Condition): Condition {
  return { all: [condition, { any: [{ exists: "resource.status" }, { not: { exists: "resource.status" } }, { exists: "resource.pages" }, { exists: "resource.tags" }, { exists: "resource.held" }] }] };
}

function safePolicy(next: () => number, index: number) {
  const condition = randomCondition(next);
  try {
    return policy(`p${index}`, {
      kind: "resource",
      effect: next() < 0.5 ? "deny" : "require",
      actions: ["vehicles.update"],
      resourceType: "vehicle",
      attributes: ATTRS,
      condition: ensureUses(condition),
    });
  } catch {
    return null;
  }
}

/** A deliberately naive evaluator over fully known facts, written independently of the real one. */
function reference(condition: Condition, f: EvaluationFacts): boolean {
  const c = condition as Record<string, unknown>;
  if ("all" in c) return (c.all as Condition[]).every((child) => reference(child, f));
  if ("any" in c) return (c.any as Condition[]).some((child) => reference(child, f));
  if ("not" in c) return !reference(c.not as Condition, f);
  if ("exists" in c) return true;
  if ("feature" in c) return f.features.get(c.feature as string) === true;
  const value = (operand: { ref?: string; value?: unknown }): unknown => {
    if (operand.ref === undefined) return operand.value;
    if (operand.ref === "subject.teamIds") return f.subject["subject.teamIds"];
    return f.resource!.attributes![operand.ref.slice("resource.".length)];
  };
  const [op] = Object.keys(c) as [string];
  const [a, b] = (c[op] as Array<{ ref?: string; value?: unknown }>).map(value) as [never, never];
  switch (op) {
    case "eq":
      return a === b;
    case "gt":
      return (a as number) > (b as number);
    case "contains":
      return (a as unknown[]).includes(b);
    case "intersects":
      return (a as unknown[]).some((item) => (b as unknown[]).includes(item));
    case "in":
      return (b as unknown[]).includes(a);
    default:
      throw new Error(`reference does not know ${op}`);
  }
}

describe("what a request needs", () => {
  it("lists only the facts of the policies that apply", () => {
    const needs = requiredFacts(
      [
        scope,
        locked,
        policy("f", { kind: "feature", effect: "require", actions: ["vehicles.update"], condition: { all: [{ feature: "fleet_pro" }, { permission: "vehicles.override" }] } }),
        policy("other", { kind: "feature", effect: "require", actions: ["tickets.read"], condition: { feature: "ticketing" } }),
      ],
      request,
    );
    expect(needs).toEqual({ features: ["fleet_pro"], permissions: ["vehicles.override"], subject: ["subject.teamIds"], resource: true, resourceTeamPath: false, environment: false, context: [], session: false });
  });
});


describe("resource attributes are read as own properties only", () => {
  it("an inherited name is never a declared attribute, even for a definition that skipped the parser", () => {
    const definition = {
      kind: "resource",
      effect: "deny",
      actions: ["vehicles.update"],
      resourceType: "vehicle",
      attributes: { status: "string" },
      condition: { exists: "resource.constructor" },
    } as unknown as PolicyDefinition;
    const facts: EvaluationFacts = { subject: {}, resource: { id: "v1", attributes: { constructor: "x" } }, features: new Map(), permissions: new Map() };
    const outcome = evaluatePolicy({ id: "p", key: "p", revision: 1, definitionHash: "h", definition }, { permission: "vehicles.update", resourceType: "vehicle" }, facts);
    expect(outcome).toMatchObject({ result: "indeterminate", reason: "attribute_missing" });
  });
});
