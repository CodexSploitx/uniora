export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "uniora_studio_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Picks the first supported language from an Accept-Language header (e.g. "es-MX,es;q=0.9,en;q=0.8"). */
export function detectLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const candidates = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
      return { base: tag.trim().toLowerCase().split("-")[0] ?? "", q: q === undefined ? 1 : Number(q) };
    })
    .filter((candidate) => candidate.base && Number.isFinite(candidate.q) && candidate.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const candidate of candidates) {
    if (isLocale(candidate.base)) return candidate.base;
  }
  return DEFAULT_LOCALE;
}
