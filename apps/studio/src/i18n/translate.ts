import type { Locale } from "@/i18n/config";
import { en } from "@/i18n/messages/en";

export type Messages = Record<keyof typeof en, string>;
type StripPlural<K> = K extends `${infer Base}_${"one" | "other"}` ? Base : K;
export type MessageKey = StripPlural<keyof typeof en>;
export type TranslateParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: TranslateParams) => string;

/**
 * `{name}` placeholders are replaced from `params`. When `params.count` is a
 * number and `<key>_one`/`<key>_other` exist, the plural form for the locale
 * is used (Intl.PluralRules). A missing key falls back to English, then to the
 * key itself — never throws, so a translation gap can't break a page.
 */
export function createTranslator(locale: Locale, messages: Messages): Translator {
  const plurals = new Intl.PluralRules(locale);
  const lookup = (key: string): string | undefined =>
    (messages as Record<string, string>)[key] ?? (en as Record<string, string>)[key];

  return (key, params) => {
    let template: string | undefined;
    if (typeof params?.count === "number") {
      template = lookup(`${key}_${plurals.select(params.count) === "one" ? "one" : "other"}`);
    }
    template ??= lookup(key) ?? key;
    // `countLabel` is a ready-made text for `{count}` (a capped total such as "10,000+"); `count` itself picks the plural.
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      if (name === "count" && typeof params?.countLabel === "string") return params.countLabel;
      return params && name in params ? String(params[name]) : match;
    });
  };
}
