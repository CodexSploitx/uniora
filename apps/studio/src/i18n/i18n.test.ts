import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, detectLocale, isLocale } from "./config";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { createTranslator } from "./translate";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

describe("message catalogs", () => {
  it("Spanish has exactly the English keys", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it("every translation keeps the same {placeholders} as English", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(es[key]), `placeholders of "${key}"`).toEqual(placeholders(en[key]));
    }
  });

  it("no translation is empty", () => {
    for (const value of [...Object.values(en), ...Object.values(es)]) expect(value.trim()).not.toBe("");
  });

  it("plural keys come in complete _one/_other pairs", () => {
    for (const catalog of [en, es]) {
      const keys = Object.keys(catalog);
      for (const key of keys.filter((candidate) => candidate.endsWith("_one"))) {
        expect(keys).toContain(key.replace(/_one$/, "_other"));
      }
    }
  });
});

describe("createTranslator", () => {
  const tEn = createTranslator("en", en);
  const tEs = createTranslator("es", es);

  it("interpolates parameters", () => {
    expect(tEn("orgs.created", { date: "today" })).toBe("Created today");
    expect(tEs("orgs.created", { date: "hoy" })).toBe("Creada el hoy");
  });

  it("selects plural forms by count", () => {
    expect(tEn("count.members", { count: 1 })).toBe("1 member");
    expect(tEn("count.members", { count: 3 })).toBe("3 members");
    expect(tEs("count.members", { count: 1 })).toBe("1 miembro");
    expect(tEs("count.members", { count: 0 })).toBe("0 miembros");
  });

  it("leaves unknown placeholders untouched and never throws on a missing key", () => {
    expect(tEn("orgs.created")).toBe("Created {date}");
    expect(tEn("does.not.exist" as never)).toBe("does.not.exist");
  });

  it("falls back to English when a translation is missing", () => {
    const partial = createTranslator("es", { ...es, "nav.manage": undefined as unknown as string });
    expect(partial("nav.manage")).toBe("Manage");
  });
});

describe("detectLocale", () => {
  it("honors Accept-Language order and quality", () => {
    expect(detectLocale("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(detectLocale("en-US,en;q=0.9,es;q=0.8")).toBe("en");
    expect(detectLocale("fr;q=0.9,es;q=0.8")).toBe("es");
    expect(detectLocale("en;q=0.2,es;q=0.9")).toBe("es");
  });

  it("falls back to the default for unsupported, empty or malformed input", () => {
    expect(detectLocale("fr,de")).toBe(DEFAULT_LOCALE);
    expect(detectLocale("")).toBe(DEFAULT_LOCALE);
    expect(detectLocale(null)).toBe(DEFAULT_LOCALE);
    expect(detectLocale(";;;,,,")).toBe(DEFAULT_LOCALE);
  });
});

describe("isLocale", () => {
  it("only accepts supported locales (untrusted cookie/action input)", () => {
    expect(isLocale("es")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale("es; Path=/")).toBe(false);
  });
});
