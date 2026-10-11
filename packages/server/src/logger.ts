export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly level: LogLevel;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** Where the server writes its log lines. One JSON object per line, never the request or response bodies, never a header. */
export type Logger = (entry: LogEntry) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys that must never be logged, whatever put them in an entry. Checked case-insensitively, at any depth. */
const SECRET_KEYS = /authorization|token|secret|password|api[-_]?key|cookie|uniora-actor|x-forwarded/i;
const KEY_SHAPE = /uniora_sk_[0-9A-Za-z_]{20,}/g;

/** Copies `value` with secret-looking keys replaced and any API key found inside a string masked. Bounded in depth. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(KEY_SHAPE, "uniora_sk_[redacted]");
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1), stack: redact(value.stack ?? "", depth + 1) };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return out;
}

/** JSON lines to a writer (stderr by default), at or above `minLevel`. */
export function createJsonLogger(options: { minLevel?: LogLevel; write?: (line: string) => void } = {}): Logger {
  const min = LEVELS[options.minLevel ?? "info"];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  return (entry) => {
    if (LEVELS[entry.level] < min) return;
    write(JSON.stringify({ ts: new Date().toISOString(), ...(redact(entry) as Record<string, unknown>) }));
  };
}

export const silentLogger: Logger = () => undefined;
