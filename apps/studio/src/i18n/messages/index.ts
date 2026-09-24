import type { Locale } from "@/i18n/config";
import type { Messages } from "@/i18n/translate";
import { en } from "./en";
import { es } from "./es";

/** Server-only registry (the client only ever receives the active locale's messages). */
export const MESSAGES: Record<Locale, Messages> = { en, es };
