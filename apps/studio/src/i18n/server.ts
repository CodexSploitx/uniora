import "server-only";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, detectLocale, isLocale, type Locale } from "@/i18n/config";
import { MESSAGES } from "@/i18n/messages";
import { createTranslator, type Messages, type Translator } from "@/i18n/translate";

/** Cookie choice wins; otherwise the browser's Accept-Language; otherwise English. */
export async function getLocale(): Promise<Locale> {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(stored)) return stored;
  return detectLocale((await headers()).get("accept-language"));
}

export async function getT(): Promise<{ t: Translator; locale: Locale; messages: Messages }> {
  const locale = await getLocale();
  const messages = MESSAGES[locale];
  return { t: createTranslator(locale, messages), locale, messages };
}
