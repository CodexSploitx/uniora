import { describe, expect, it } from "vitest";
import { PermissionError } from "./repository.js";
import { assertValidPermissionKey, sanitizePermissionName } from "./key.js";

describe("sanitizePermissionName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizePermissionName("  Delete   Vehicles  ")).toBe("Delete Vehicles");
  });

  it("rejects an empty name", () => {
    expect(() => sanitizePermissionName("   ")).toThrow(PermissionError);
  });

  it("rejects a name over 100 characters", () => {
    expect(() => sanitizePermissionName("a".repeat(101))).toThrow(PermissionError);
  });
});

describe("assertValidPermissionKey", () => {
  it("accepts a two-segment resource.action key", () => {
    expect(assertValidPermissionKey("vehicles.delete")).toBe("vehicles.delete");
  });

  it("accepts a key with more than two segments", () => {
    expect(assertValidPermissionKey("anything.at.all")).toBe("anything.at.all");
  });

  it("accepts underscores within a segment", () => {
    expect(assertValidPermissionKey("audit_logs.read")).toBe("audit_logs.read");
  });

  it("rejects an empty key", () => {
    expect(() => assertValidPermissionKey("")).toThrow(PermissionError);
  });

  it("rejects a key with a single segment (no dot)", () => {
    expect(() => assertValidPermissionKey("vehicles")).toThrow(PermissionError);
  });

  it("rejects uppercase characters", () => {
    expect(() => assertValidPermissionKey("Vehicles.Delete")).toThrow(PermissionError);
  });

  it("rejects spaces", () => {
    expect(() => assertValidPermissionKey("vehicles delete")).toThrow(PermissionError);
  });

  it("rejects leading/trailing/duplicate dots", () => {
    expect(() => assertValidPermissionKey(".vehicles.delete")).toThrow(PermissionError);
    expect(() => assertValidPermissionKey("vehicles.delete.")).toThrow(PermissionError);
    expect(() => assertValidPermissionKey("vehicles..delete")).toThrow(PermissionError);
  });

  it("rejects hyphens — permission keys are dot-namespaced, not hyphenated", () => {
    expect(() => assertValidPermissionKey("vehicles.delete-all")).toThrow(PermissionError);
  });

  it("rejects a key over 150 characters", () => {
    expect(() => assertValidPermissionKey(`${"a".repeat(150)}.b`)).toThrow(PermissionError);
  });

  it("never transforms the input — malformed input is rejected, not normalized", () => {
    // uniora-security-engineering §9: silently normalizing a
    // security-sensitive identifier risks collisions. A key with
    // uppercase or extra whitespace must be rejected outright, never
    // silently lowercased/trimmed into something that happens to match.
    expect(() => assertValidPermissionKey(" vehicles.delete ")).toThrow(PermissionError);
  });
});
