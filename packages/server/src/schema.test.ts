import { describe, expect, it } from "vitest";
import { ResponseShapeError, parseInput, project, s, toJsonSchema } from "./schema.js";
import type { Infer } from "./schema.js";

const identity = s.object({
  provider: s.optional(s.string({ max: 200, min: 1 })),
  subject: s.string({ max: 500, min: 1 }),
});
const body = s.object({
  identity,
  organizationId: s.string({ max: 200, min: 1 }),
  checks: s.array(s.object({ permission: s.string({ max: 100 }), teamId: s.optional(s.string({ max: 200 })) }), { max: 3 }),
  at: s.optional(s.date()),
  level: s.optional(s.int({ min: 0, max: 100 })),
  flag: s.optional(s.bool()),
  kind: s.optional(s.enum(["a", "b"] as const)),
  extra: s.optional(s.json({ maxDepth: 3, maxNodes: 20, maxString: 20 })),
  signals: s.optional(s.record(s.bool(), { maxKeys: 2, keyPattern: /^[a-z]+$/ })),
});

const valid = { identity: { subject: "u1" }, organizationId: "org", checks: [{ permission: "a.b" }] };

describe("parseInput", () => {
  it("accepts a valid body and infers its type", () => {
    const result = parseInput(body, { ...valid, at: "2026-10-10T12:00:00Z", level: 3, kind: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const typed: Infer<typeof body> = result.value;
    expect(typed.at).toEqual(new Date("2026-10-10T12:00:00Z"));
    expect(typed.identity.provider).toBeUndefined();
    expect(typed.kind).toBe("a");
  });

  it("is strict: an unknown field is an error, at every level", () => {
    const result = parseInput(body, { ...valid, admin: true, identity: { subject: "u", role: "x" }, checks: [{ permission: "a", sneaky: 1 }] });
    expect(result).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        { path: "admin", code: "unknown_field" },
        { path: "identity.role", code: "unknown_field" },
        { path: "checks[0].sneaky", code: "unknown_field" },
      ]),
    });
  });

  it("reports what is missing or of the wrong type, never the value", () => {
    const result = parseInput(body, { identity: { subject: 5 }, checks: "no" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "identity.subject", code: "type" },
        { path: "organizationId", code: "required" },
        { path: "checks", code: "type" },
      ]),
    );
    expect(JSON.stringify(result.issues)).not.toContain("no");
  });

  it("enforces every bound", () => {
    const cases: [unknown, string, string][] = [
      [{ ...valid, organizationId: "x".repeat(201) }, "organizationId", "too_long"],
      [{ ...valid, organizationId: "" }, "organizationId", "too_short"],
      [{ ...valid, checks: Array.from({ length: 4 }, () => ({ permission: "a" })) }, "checks", "too_many"],
      [{ ...valid, level: 101 }, "level", "out_of_range"],
      [{ ...valid, level: 1.5 }, "level", "type"],
      [{ ...valid, level: Number.NaN }, "level", "type"],
      [{ ...valid, kind: "c" }, "kind", "enum"],
      [{ ...valid, at: "yesterday" }, "at", "invalid_date"],
      [{ ...valid, at: "2026-13-45T99:99:99Z" }, "at", "invalid_date"],
      [{ ...valid, at: 1760000000 }, "at", "type"],
      [{ ...valid, organizationId: "a\u0000b" }, "organizationId", "pattern"],
    ];
    for (const [input, path, code] of cases) {
      const result = parseInput(body, input);
      expect(result.ok, `${path} ${code}`).toBe(false);
      if (!result.ok) expect(result.issues).toContainEqual({ path, code });
    }
  });

  it("refuses non-plain objects and arrays where an object is expected", () => {
    expect(parseInput(body, null).ok).toBe(false);
    expect(parseInput(body, []).ok).toBe(false);
    expect(parseInput(body, "x").ok).toBe(false);
    expect(parseInput(body, new Date()).ok).toBe(false);
    expect(parseInput(body, Object.create({ inherited: 1 })).ok).toBe(false);
  });

  it("free-form objects are bounded in depth, size and string length, and cannot smuggle prototype keys", () => {
    const withExtra = (extra: unknown) => parseInput(body, { ...valid, extra });
    expect(withExtra({ a: { b: { c: 1 } } }).ok).toBe(true);
    expect(withExtra({ a: { b: { c: { d: 1 } } } }).ok).toBe(false);
    expect(withExtra(Array.from({ length: 30 }, (_, i) => i)).ok).toBe(false);
    expect(withExtra("x".repeat(21)).ok).toBe(false);
    expect(withExtra(JSON.parse('{"__proto__": {"admin": true}}')).ok).toBe(false);
    expect(withExtra({ constructor: 1 }).ok).toBe(false);
    expect(withExtra({ ok: undefined }).ok).toBe(false);
    expect(withExtra(() => 1).ok).toBe(false);
    const signals = (value: unknown) => parseInput(body, { ...valid, signals: value });
    expect(signals({ a: true }).ok).toBe(true);
    expect(signals({ A: true }).ok).toBe(false);
    expect(signals(JSON.parse('{"__proto__": true}')).ok).toBe(false);
    expect(signals({ a: true, b: true, c: true }).ok).toBe(false);
  });

  it("never pollutes Object.prototype", () => {
    parseInput(body, { ...valid, extra: JSON.parse('{"__proto__": {"polluted": true}}') });
    parseInput(body, { ...valid, signals: JSON.parse('{"__proto__": true}') });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("caps the number of reported issues", () => {
    const result = parseInput(s.array(s.int({ min: 0, max: 1 }), { max: 1000 }), Array.from({ length: 500 }, () => "x"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBe(20);
  });
});

describe("project", () => {
  const response = s.object({
    id: s.string({ max: 10 }),
    createdAt: s.date(),
    note: s.optional(s.string({ max: 10 })),
    parent: s.nullable(s.string({ max: 10 })),
    tags: s.array(s.object({ key: s.string({ max: 10 }) }), { max: 10 }),
  });

  it("keeps exactly the declared fields and formats dates", () => {
    const projected = project(response, {
      id: "a",
      createdAt: new Date("2026-10-10T12:00:00.000Z"),
      parent: null,
      tags: [{ key: "k", secretHash: "deadbeef" }],
      secretHash: "deadbeef",
      internal: { anything: true },
    });
    expect(projected).toEqual({ id: "a", createdAt: "2026-10-10T12:00:00.000Z", parent: null, tags: [{ key: "k" }] });
    expect(JSON.stringify(projected)).not.toContain("deadbeef");
  });

  it("a declared field that is missing or of the wrong type is a server bug, not a client error", () => {
    expect(() => project(response, { createdAt: new Date(), parent: null, tags: [] })).toThrow(ResponseShapeError);
    expect(() => project(response, { id: 5, createdAt: new Date(), parent: null, tags: [] })).toThrow(ResponseShapeError);
    expect(() => project(response, { id: "a", createdAt: "2026-10-10", parent: null, tags: [] })).toThrow(ResponseShapeError);
    expect(() => project(response, { id: "a", createdAt: new Date(Number.NaN), parent: null, tags: [] })).toThrow(ResponseShapeError);
  });
});

describe("toJsonSchema", () => {
  it("describes the same bounds the parser enforces", () => {
    const schema = toJsonSchema(body) as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["identity", "organizationId", "checks"]);
    expect(schema.properties.organizationId).toMatchObject({ type: "string", maxLength: 200, minLength: 1 });
    expect(schema.properties.checks).toMatchObject({ type: "array", maxItems: 3 });
    expect(schema.properties.at).toMatchObject({ type: "string", format: "date-time" });
    expect(schema.properties.level).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    expect(toJsonSchema(s.nullable(s.string({ max: 3 })))).toMatchObject({ type: ["string", "null"] });
  });
});
