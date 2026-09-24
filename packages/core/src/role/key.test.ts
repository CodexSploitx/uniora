import { describe, expect, it } from "vitest";
import { RoleError } from "./repository.js";
import { assertValidRoleKey, resolveRoleKey, sanitizeRoleName } from "./key.js";

describe("sanitizeRoleName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeRoleName("  Billing   Manager  ")).toBe("Billing Manager");
  });

  it("rejects an empty name", () => {
    expect(() => sanitizeRoleName("   ")).toThrow(RoleError);
  });

  it("rejects a name over 100 characters", () => {
    expect(() => sanitizeRoleName("a".repeat(101))).toThrow(RoleError);
  });

  it("accepts a name at exactly 100 characters", () => {
    expect(sanitizeRoleName("a".repeat(100))).toHaveLength(100);
  });
});

describe("assertValidRoleKey", () => {
  it("accepts a lowercase, hyphenated key", () => {
    expect(assertValidRoleKey("billing-manager")).toBe("billing-manager");
  });

  it("rejects an empty key", () => {
    expect(() => assertValidRoleKey("")).toThrow(RoleError);
  });

  it("rejects uppercase characters", () => {
    expect(() => assertValidRoleKey("Billing")).toThrow(RoleError);
  });

  it("rejects spaces", () => {
    expect(() => assertValidRoleKey("billing manager")).toThrow(RoleError);
  });

  it("rejects leading/trailing/duplicate hyphens", () => {
    expect(() => assertValidRoleKey("-billing")).toThrow(RoleError);
    expect(() => assertValidRoleKey("billing-")).toThrow(RoleError);
    expect(() => assertValidRoleKey("billing--manager")).toThrow(RoleError);
  });

  it('rejects "owner" — reserved for the protected Owner role', () => {
    expect(() => assertValidRoleKey("owner")).toThrow(RoleError);
  });

  it("rejects a key over 63 characters", () => {
    expect(() => assertValidRoleKey("a".repeat(64))).toThrow(RoleError);
  });
});

describe("resolveRoleKey", () => {
  it("derives a key from the name when no explicit key is given", () => {
    expect(resolveRoleKey("Billing Manager")).toBe("billing-manager");
  });

  it("strips diacritics when deriving", () => {
    expect(resolveRoleKey("Facturación")).toBe("facturacion");
  });

  it("uses the explicit key as-is instead of deriving one", () => {
    expect(resolveRoleKey("Billing Manager", "billing")).toBe("billing");
  });

  it("validates the explicit key even when it doesn't match the name", () => {
    expect(() => resolveRoleKey("Billing Manager", "Not Valid")).toThrow(RoleError);
  });

  it('rejects a name that derives to the reserved "owner" key', () => {
    expect(() => resolveRoleKey("Owner")).toThrow(RoleError);
    expect(() => resolveRoleKey("OWNER")).toThrow(RoleError);
  });

  it("rejects a name that derives to an empty key", () => {
    expect(() => resolveRoleKey("!!!")).toThrow(RoleError);
  });
});
