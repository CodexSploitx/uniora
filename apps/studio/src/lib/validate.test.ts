import { describe, expect, it } from "vitest";
import { InputError, text, textList } from "./validate";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof InputError ? error.code : "other";
  }
  return undefined;
};

describe("text (untrusted action input)", () => {
  it("trims and returns a valid string", () => {
    expect(text("  Acme  ", "field.name", {})).toBe("Acme");
  });

  it.each([undefined, null, "", "   "])("rejects missing value %j when required", (value) => {
    expect(codeOf(() => text(value, "field.name", {}))).toBe("required");
  });

  it("returns undefined for a missing optional value", () => {
    expect(text(undefined, "field.slug", { optional: true })).toBeUndefined();
    expect(text("  ", "field.slug", { optional: true })).toBeUndefined();
  });

  it.each([42, true, {}, [], ["a"]])("rejects non-string %j (type confusion)", (value) => {
    expect(codeOf(() => text(value, "field.name", {}))).toBe("mustBeText");
  });

  it("enforces the max length and reports which field", () => {
    expect(codeOf(() => text("a".repeat(11), "field.name", { max: 10 }))).toBe("tooLong");
    expect(text("a".repeat(10), "field.name", { max: 10 })).toHaveLength(10);
    try {
      text("a".repeat(11), "field.slug", { max: 10 });
    } catch (error) {
      expect((error as InputError).field).toBe("field.slug");
    }
  });
});

describe("textList", () => {
  it("defaults to an empty list", () => {
    expect(textList(undefined, "field.permissions")).toEqual([]);
  });

  it("validates every item", () => {
    expect(textList([" a.b ", "c.d"], "field.permissions")).toEqual(["a.b", "c.d"]);
    expect(codeOf(() => textList(["ok", 5], "field.permissions"))).toBe("mustBeText");
    expect(codeOf(() => textList("nope", "field.permissions"))).toBe("mustBeList");
  });

  it("caps the list size", () => {
    expect(codeOf(() => textList(Array.from({ length: 501 }, () => "a.b"), "field.permissions"))).toBe("mustBeList");
  });
});
