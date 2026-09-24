"use server";

import { cookies } from "next/headers";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";
import { requireSession } from "@/lib/session";

/** Display-language preference only (no data change), so it stays available in read-only mode. */
export async function setLocale(locale: string): Promise<void> {
  await requireSession();
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", sameSite: "strict", maxAge: 60 * 60 * 24 * 365 });
}
