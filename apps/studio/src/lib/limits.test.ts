import { describe, expect, it } from "vitest";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/messages/en";
import { capLabel, capParams, countLimit, FILTERED_CAP, TOTAL_CAP } from "@/lib/limits";

describe("count caps", () => {
  it("asks for one row more than the cap, which is what says 'more than'", () => {
    expect(countLimit()).toBe(TOTAL_CAP + 1);
    expect(countLimit(true)).toBe(FILTERED_CAP + 1);
  });

  it("shows a count that hit its cap as 'N+' and an exact total in full", () => {
    expect(capLabel(TOTAL_CAP + 1, "en-US")).toBe("10,000+");
    expect(capLabel(FILTERED_CAP + 1, "en-US")).toBe("1,000+");
    expect(capLabel(5_000_000, "en-US")).toBe("5,000,000");
    expect(capLabel(42, "en-US")).toBe("42");
  });

  it("formats translated counts for the language and keeps the plural", () => {
    const t = createTranslator("en", en);
    expect(t("members.resultsCount", capParams(5_000_000))).toBe("5,000,000 members");
    expect(t("members.resultsCount", capParams(TOTAL_CAP + 1))).toBe("10,000+ members");
    expect(t("members.resultsCount", capParams(1))).toBe("1 member");
    expect(createTranslator("es", en)("members.resultsCount", capParams(5_000_000))).toBe("5.000.000 members");
  });
});
