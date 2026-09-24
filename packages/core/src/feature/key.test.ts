import { describe, expect, it } from "vitest";
import { FeatureError } from "./repository.js";
import { assertValidFeatureKey, resolveFeatureKey, sanitizeFeatureName } from "./key.js";

describe("sanitizeFeatureName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeFeatureName("  Advanced   Reports  ")).toBe("Advanced Reports");
  });

  it("rejects an empty name", () => {
    expect(() => sanitizeFeatureName("   ")).toThrow(FeatureError);
  });

  it("rejects a name over 100 characters", () => {
    expect(() => sanitizeFeatureName("a".repeat(101))).toThrow(FeatureError);
  });
});

describe("assertValidFeatureKey", () => {
  it("accepts a lowercase, underscore-separated key", () => {
    expect(assertValidFeatureKey("advanced_reports")).toBe("advanced_reports");
  });

  it("rejects an empty key", () => {
    expect(() => assertValidFeatureKey("")).toThrow(FeatureError);
  });

  it("rejects uppercase characters", () => {
    expect(() => assertValidFeatureKey("Advanced_Reports")).toThrow(FeatureError);
  });

  it("rejects hyphens — feature keys are underscore-separated, not hyphenated", () => {
    expect(() => assertValidFeatureKey("advanced-reports")).toThrow(FeatureError);
  });

  it("rejects spaces", () => {
    expect(() => assertValidFeatureKey("advanced reports")).toThrow(FeatureError);
  });

  it("rejects leading/trailing/duplicate underscores", () => {
    expect(() => assertValidFeatureKey("_advanced")).toThrow(FeatureError);
    expect(() => assertValidFeatureKey("advanced_")).toThrow(FeatureError);
    expect(() => assertValidFeatureKey("advanced__reports")).toThrow(FeatureError);
  });

  it("rejects a key over 63 characters", () => {
    expect(() => assertValidFeatureKey("a".repeat(64))).toThrow(FeatureError);
  });
});

describe("resolveFeatureKey", () => {
  it("derives an underscore-separated key from the name when no explicit key is given", () => {
    expect(resolveFeatureKey("Advanced Reports")).toBe("advanced_reports");
  });

  it("strips diacritics when deriving", () => {
    expect(resolveFeatureKey("Facturación Avanzada")).toBe("facturacion_avanzada");
  });

  it("uses the explicit key as-is instead of deriving one", () => {
    expect(resolveFeatureKey("Advanced Reports", "reports_v2")).toBe("reports_v2");
  });

  it("validates the explicit key even when it doesn't match the name", () => {
    expect(() => resolveFeatureKey("Advanced Reports", "Not Valid")).toThrow(FeatureError);
  });

  it("rejects a name that derives to an empty key", () => {
    expect(() => resolveFeatureKey("!!!")).toThrow(FeatureError);
  });
});
