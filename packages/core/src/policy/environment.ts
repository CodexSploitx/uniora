import type { EnvironmentAttributeName } from "./attributes.js";

/** The timezone a policy uses when it does not declare one. */
export const DEFAULT_POLICY_TIMEZONE = "UTC";

const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const MAX_TIMEZONE_LENGTH = 64;
/** Formatters are built once per timezone; a process sees at most as many as policies declare (bounded by the policy limits). */
const MAX_CACHED_FORMATTERS = 128;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  if (formatters.has(timezone)) return formatters.get(timezone)!;
  let formatter: Intl.DateTimeFormat | null = null;
  if (timezone.length <= MAX_TIMEZONE_LENGTH && TIMEZONE_PATTERN.test(timezone)) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
      });
    } catch {
      formatter = null;
    }
  }
  if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.delete(formatters.keys().next().value as string);
  formatters.set(timezone, formatter);
  return formatter;
}

/** Whether `timezone` is an IANA timezone name this runtime knows (`Europe/Madrid`, `UTC`). Offsets such as `+02:00` are not accepted: they do not follow daylight saving. */
export function isValidTimezone(timezone: unknown): timezone is string {
  return typeof timezone === "string" && formatterFor(timezone) !== null;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * The clock attributes at `epochMs` as seen in `timezone`, or `null` when the instant or the timezone cannot be used (the
 * policies that read them become indeterminate: a clock nobody can read is not "any time").
 * Pure: the same instant and timezone always give the same answer (as long as the runtime's timezone database is the same).
 */
export function environmentAt(epochMs: number, timezone: string): Record<EnvironmentAttributeName, number> | null {
  if (!Number.isFinite(epochMs)) return null;
  const formatter = formatterFor(timezone);
  if (formatter === null) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(new Date(epochMs));
  } catch {
    return null;
  }
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((part) => part.type === type)?.value;
  const year = Number(read("year"));
  const month = Number(read("month"));
  const dayOfMonth = Number(read("day"));
  const hour = Number(read("hour")) % 24;
  const minute = Number(read("minute"));
  const dayOfWeek = WEEKDAYS[read("weekday") ?? ""];
  if (![year, month, dayOfMonth, hour, minute].every(Number.isInteger) || dayOfWeek === undefined) return null;
  const out = {
    "environment.epochSeconds": Math.floor(epochMs / 1000),
    "environment.year": year,
    "environment.month": month,
    "environment.dayOfMonth": dayOfMonth,
    "environment.dayOfWeek": dayOfWeek,
    "environment.hour": hour,
    "environment.minuteOfDay": hour * 60 + minute,
    "environment.dateNumber": year * 10_000 + month * 100 + dayOfMonth,
  } satisfies Record<EnvironmentAttributeName, number>;
  return out;
}
