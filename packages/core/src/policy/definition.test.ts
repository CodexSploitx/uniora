import { describe, expect, it } from "vitest";
import {
  MAX_CONDITION_CHILDREN,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  PolicyError,
  actionCandidates,
  actionMatches,
  assertValidPolicyKey,
  parsePolicyDefinition,
} from "../index.js";

const scope = {
  kind: "scope",
  effect: "require",
  actions: ["vehicles.update", "vehicles.read"],
  resourceType: "vehicle",
  condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] },
};

const locked = {
  kind: "resource",
  effect: "deny",
  actions: ["vehicles.*"],
  resourceType: "vehicle",
  attributes: { status: "string" },
  condition: { eq: [{ ref: "resource.status" }, { value: "locked" }] },
  denyReason: "vehicle_locked",
};

const code = (input: unknown): string => {
  try {
    parsePolicyDefinition(input);
    return "ok";
  } catch (error) {
    return error instanceof PolicyError ? error.code : String(error);
  }
};
const message = (input: unknown): string => {
  try {
    parsePolicyDefinition(input);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
};
const withCondition = (condition: unknown, extra: Record<string, unknown> = {}) => ({ ...scope, kind: "access", resourceType: undefined, condition, ...extra });

describe("parsePolicyDefinition: what gets in", () => {
  it("normalizes a definition and hashes it the same whatever the order of keys and actions", () => {
    const a = parsePolicyDefinition(scope);
    const b = parsePolicyDefinition({ condition: scope.condition, resourceType: "vehicle", actions: ["vehicles.read", "vehicles.update"], effect: "require", kind: "scope" });
    expect(a.definition.actions).toEqual(["vehicles.read", "vehicles.update"]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.analysis.subjectRefs).toEqual(["subject.teamIds"]);
    expect(a.analysis.resourceRefs).toEqual(["resource.teamIds"]);
    expect(parsePolicyDefinition(locked).hash).not.toBe(a.hash);
  });

  it("returns a copy: changing the input afterwards does not change what was parsed", () => {
    const input = structuredClone(locked);
    const parsed = parsePolicyDefinition(input);
    input.actions.push("tickets.read");
    expect(parsed.definition.actions).toEqual(["vehicles.*"]);
  });

  it("is idempotent on its own output", () => {
    const once = parsePolicyDefinition(locked);
    expect(parsePolicyDefinition(once.definition).hash).toBe(once.hash);
  });

  it("accepts every operator with well-typed operands", () => {
    const ok = {
      kind: "resource",
      effect: "deny",
      actions: ["docs.delete"],
      resourceType: "document",
      attributes: { status: "string", pages: "number", held: "boolean", tags: "string[]", scores: "number[]" },
      condition: {
        any: [
          { eq: [{ ref: "resource.status" }, { value: "x" }] },
          { neq: [{ ref: "resource.held" }, { value: false }] },
          { lt: [{ ref: "resource.pages" }, { value: 3 }] },
          { lte: [{ ref: "resource.pages" }, { value: 3 }] },
          { gt: [{ ref: "resource.pages" }, { value: 3 }] },
          { gte: [{ ref: "resource.pages" }, { value: 3 }] },
          { in: [{ ref: "resource.status" }, { value: ["a", "b"] }] },
          { in: [{ ref: "resource.pages" }, { value: [1, 2] }] },
          { contains: [{ ref: "resource.tags" }, { value: "legal" }] },
          { contains: [{ ref: "resource.scores" }, { value: 4 }] },
          { intersects: [{ ref: "resource.tags" }, { value: ["a"] }] },
          { exists: "resource.status" },
          { not: { feature: "reports_advanced" } },
          { all: [{ permission: "docs.override" }, { exists: "subject.teamIds" }] },
        ],
      },
    };
    expect(code(ok)).toBe("ok");
  });
});

describe("parsePolicyDefinition: what is refused", () => {
  it("has no way to grant: there is no allow effect", () => {
    expect(code({ ...scope, effect: "allow" })).toBe("policy_definition_invalid");
    expect(message({ ...scope, effect: "allow" })).toMatch(/cannot grant/);
  });

  it("refuses unknown fields, missing fields and things that are not objects", () => {
    expect(code({ ...scope, extra: 1 })).toBe("policy_definition_invalid");
    expect(code({ ...scope, actions: undefined })).toBe("policy_definition_invalid");
    expect(code({ ...scope, condition: undefined })).toBe("policy_definition_invalid");
    for (const value of [null, undefined, 1, "x", [], () => 1]) expect(code(value)).toBe("policy_definition_invalid");
  });

  it("refuses the kinds that are designed but not available, and unknown kinds", () => {
    expect(message({ ...scope, kind: "contextual" })).toMatch(/not available yet/);
    expect(message({ ...scope, kind: "sensitive" })).toMatch(/not available yet/);
    expect(code({ ...scope, kind: "magic" })).toBe("policy_definition_invalid");
  });

  it("refuses the reserved namespaces (time, request, session, context)", () => {
    for (const ref of ["environment.now", "context.ip", "request.ip", "session.age"]) {
      expect(message(withCondition({ eq: [{ ref }, { value: "x" }] }))).toMatch(/reserved/);
    }
  });

  it("refuses attributes that are unknown, undeclared or declared and unused", () => {
    expect(code(withCondition({ eq: [{ ref: "subject.password" }, { value: "x" }] }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ exists: "whatever.x" }))).toBe("policy_definition_invalid");
    expect(message({ ...locked, condition: { eq: [{ ref: "resource.owner" }, { value: "x" }] } })).toMatch(/not declared/);
    expect(message({ ...locked, attributes: { status: "string", owner: "string" } })).toMatch(/never reads/);
    expect(message({ ...locked, attributes: { id: "string", status: "string" } })).toMatch(/built in/);
    expect(code({ ...locked, attributes: { Status: "string" } })).toBe("policy_definition_invalid");
    expect(code({ ...locked, attributes: { status: "date" } })).toBe("policy_definition_invalid");
    expect(message({ ...locked, resourceType: undefined })).toMatch(/resourceType/);
  });

  it("type-checks every comparison statically", () => {
    const bad = (condition: unknown) => code({ ...locked, attributes: { status: "string", pages: "number", tags: "string[]" }, condition });
    expect(bad({ eq: [{ ref: "resource.status" }, { value: 1 }] })).toBe("policy_definition_invalid");
    expect(bad({ lt: [{ ref: "resource.status" }, { value: "b" }] })).toBe("policy_definition_invalid");
    expect(bad({ in: [{ ref: "resource.status" }, { value: "a" }] })).toBe("policy_definition_invalid");
    expect(bad({ in: [{ ref: "resource.pages" }, { value: ["a"] }] })).toBe("policy_definition_invalid");
    expect(bad({ contains: [{ ref: "resource.status" }, { value: "a" }] })).toBe("policy_definition_invalid");
    expect(bad({ contains: [{ ref: "resource.tags" }, { value: 1 }] })).toBe("policy_definition_invalid");
    expect(bad({ intersects: [{ ref: "resource.tags" }, { value: [1] }] })).toBe("policy_definition_invalid");
    expect(bad({ eq: [{ ref: "resource.tags" }, { value: ["a"] }] })).toBe("policy_definition_invalid");
    expect(bad({ eq: [{ ref: "resource.status" }] })).toBe("policy_definition_invalid");
    expect(bad({ eq: [{ ref: "resource.status" }, { value: "a" }, { value: "b" }] })).toBe("policy_definition_invalid");
    expect(bad({ eq: [{ ref: "resource.status", value: "a" }, { value: "a" }] })).toBe("policy_definition_invalid");
    expect(bad({ in: [{ ref: "resource.status" }, { value: [] }] })).toBe("policy_definition_invalid");
    expect(bad({ in: [{ ref: "resource.status" }, { value: ["a", 1] }] })).toBe("policy_definition_invalid");
    expect(bad({ eq: [{ ref: "resource.status" }, { value: null }] })).toBe("policy_definition_invalid");
    expect(bad({ eq: [{ ref: "resource.status" }, { value: { x: 1 } }] })).toBe("policy_definition_invalid");
  });

  it("allows exactly one operator per node, and lists must be well-formed", () => {
    expect(code(withCondition({}))).toBe("policy_definition_invalid");
    expect(code(withCondition({ feature: "a_b", not: { feature: "c" } }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ all: [] }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ any: "x" }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ bogus: 1 }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ feature: "Not A Key" }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ permission: "nodot" }))).toBe("policy_definition_invalid");
  });

  it("bounds depth, size, fan-out, literals and lookups", () => {
    let deep: unknown = { feature: "a_b" };
    for (let i = 0; i < MAX_CONDITION_DEPTH; i++) deep = { not: deep };
    expect(code(withCondition(deep))).toBe("policy_definition_invalid");
    expect(message(withCondition(deep))).toMatch(/nested at most/);

    const wide = { all: Array.from({ length: MAX_CONDITION_CHILDREN + 1 }, () => ({ feature: "a_b" })) };
    expect(message(withCondition(wide))).toMatch(/at most 16/);

    const big = { any: Array.from({ length: 8 }, () => ({ all: Array.from({ length: 8 }, () => ({ feature: "a_b" })) })) };
    expect(MAX_CONDITION_NODES).toBeLessThan(80);
    expect(message(withCondition(big))).toMatch(/too large/);

    expect(code(withCondition({ eq: [{ value: "x".repeat(257) }, { value: "y" }] }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ in: [{ value: "x" }, { value: Array.from({ length: 101 }, (_, i) => `v${i}`) }] }))).toBe("policy_definition_invalid");

    const sixteen = { all: Array.from({ length: 16 }, (_, i) => ({ feature: `f_k${i}` })) };
    expect(code(withCondition({ all: [sixteen, { permission: "a.b" }] }))).toBe("policy_definition_invalid");
    expect(message(withCondition({ all: [sixteen, { permission: "a.b" }] }))).toMatch(/at most 16 features and permissions|too large/);
    expect(code(withCondition(sixteen))).toBe("ok");
  });

  it("refuses input that is not plain data: prototypes, accessors, symbols, cycles, huge or non-finite", () => {
    expect(code(JSON.parse('{"kind":"access","effect":"deny","actions":["a.b"],"condition":{"feature":"a.b"},"__proto__":{"x":1}}'))).toBe("policy_definition_invalid");
    class Rule {
      kind = "access";
    }
    expect(code(new Rule())).toBe("policy_definition_invalid");
    const accessor = { ...withCondition({ feature: "a_b" }) } as Record<string, unknown>;
    Object.defineProperty(accessor, "denyReason", { enumerable: true, get: () => "x" });
    expect(code(accessor)).toBe("policy_definition_invalid");
    const symbolic = { ...withCondition({ feature: "a_b" }), [Symbol("x")]: 1 };
    expect(code(symbolic)).toBe("policy_definition_invalid");
    const cyclic: Record<string, unknown> = { ...withCondition({ feature: "a_b" }) };
    cyclic.condition = { not: cyclic };
    expect(code(cyclic)).toBe("policy_definition_invalid");
    expect(code(withCondition({ eq: [{ value: Number.NaN }, { value: 1 }] }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ eq: [{ value: Infinity }, { value: 1 }] }))).toBe("policy_definition_invalid");
    expect(code({ ...withCondition({ feature: "a_b" }), denyReason: "x".repeat(5000) })).toBe("policy_definition_invalid");
    const holes: unknown[] = [];
    holes[2] = "a.b";
    expect(code({ ...withCondition({ feature: "a_b" }), actions: holes })).toBe("policy_definition_invalid");
  });

  it("never lets a policy reach the policy administration permissions", () => {
    expect(code(withCondition({ feature: "a_b" }, { actions: ["policies.manage"] }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ feature: "a_b" }, { actions: ["policies.*"] }))).toBe("policy_definition_invalid");
    expect(code(withCondition({ feature: "a_b" }, { actions: ["*"] }))).toBe("ok");
    expect(actionMatches(["*"], "policies.manage")).toBe(false);
    expect(actionMatches(["*"], "vehicles.update")).toBe(true);
  });

  it("checks actions", () => {
    for (const actions of [[], "vehicles.update", ["Vehicles.Update"], ["vehicles"], ["vehicles.*.x"], ["*.update"], [1], Array.from({ length: 33 }, (_, i) => `a.k${i}`)]) {
      expect(code(withCondition({ feature: "a_b" }, { actions }))).toBe("policy_definition_invalid");
    }
  });

  it("holds each kind to what it says", () => {
    expect(message({ ...locked, kind: "access" })).toMatch(/state of the resource/);
    expect(message({ ...locked, kind: "scope" })).toMatch(/subject/);
    expect(message({ ...scope, kind: "feature" })).toMatch(/feature/);
    expect(message({ ...scope, kind: "resource" })).toMatch(/declared resource attribute/);
    expect(code(withCondition({ feature: "reports_advanced" }, { kind: "feature" }))).toBe("ok");
    expect(code(withCondition({ eq: [{ ref: "subject.membershipStatus" }, { value: "active" }] }, { kind: "access" }))).toBe("ok");
  });
});

describe("action matching", () => {
  it("matches exact keys, prefixes and the wildcard, and nothing else", () => {
    expect(actionMatches(["vehicles.update"], "vehicles.update")).toBe(true);
    expect(actionMatches(["vehicles.update"], "vehicles.read")).toBe(false);
    expect(actionMatches(["vehicles.*"], "vehicles.update")).toBe(true);
    expect(actionMatches(["vehicles.*"], "vehiclesx.update")).toBe(false);
    expect(actionMatches(["vehicles.*"], "vehicles.parts.update")).toBe(true);
    expect(actionMatches(["vehicles.parts.*"], "vehicles.update")).toBe(false);
  });

  it("lists the candidate patterns from specific to general, which is what a backend looks up", () => {
    expect(actionCandidates("vehicles.parts.update")).toEqual(["vehicles.parts.update", "vehicles.parts.*", "vehicles.*", "*"]);
    expect(actionCandidates("vehicles.update")).toEqual(["vehicles.update", "vehicles.*", "*"]);
    for (const permission of ["vehicles.update", "a.b.c.d"]) {
      for (const pattern of actionCandidates(permission)) expect(actionMatches([pattern], permission)).toBe(true);
    }
  });
});

describe("policy keys", () => {
  it("accepts lowercase dotted/hyphenated keys only", () => {
    for (const key of ["a", "vehicles.locked-readonly", "tickets_closed.v2"]) expect(assertValidPolicyKey(key)).toBe(key);
    for (const key of ["", "A", "a b", ".a", "a.", "a..b", "-a", "a".repeat(101), 1, null]) expect(() => assertValidPolicyKey(key)).toThrow(PolicyError);
  });
});

describe("attribute names are looked up as own properties only", () => {
  it("does not treat names every object inherits as declared attributes", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      // Declared elsewhere, so the policy has a resourceType and one real attribute.
      const refs = { ...locked, condition: { all: [locked.condition, { exists: `resource.${name}` }] } };
      expect(code(refs), name).toBe("policy_definition_invalid");
    }
  });

  it("still lets a policy declare and read an attribute that shares such a name", () => {
    const own = { ...locked, attributes: { toString: "string" }, condition: { eq: [{ ref: "resource.toString" }, { value: "x" }] } };
    expect(code(own)).toBe("ok");
  });
});
